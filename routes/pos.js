const crypto  = require('crypto');
const router  = require('express').Router();
const pool    = require('../db');
const { requireTerminalAuth, verifyTerminalToken } = require('../middleware/terminalAuth');
const { toCambodiaTime } = require('../utils/date');
const { generateOrderNumber } = require('../services/pos/orderNumber');
const { canTransition, TERMINAL } = require('../services/pos/stateMachine');

const CATALOG_TTL_MS = 60 * 1000;
let catalogCache = null; // { data, expiresAt }

const ITEM_KITCHEN_STATUSES = ['pending', 'preparing', 'done'];

// KDS realtime: server-held list of open SSE connections. EventSource can't
// set an Authorization header, so /kds/stream verifies the JWT from a query
// param instead of going through requireAuth.
const kdsClients = new Set();

function broadcastOrdersChanged() {
  const payload = `data: ${JSON.stringify({ type: 'orders_changed' })}\n\n`;
  for (const res of kdsClients) res.write(payload);
}

// Discovered in Phase 1 from receipt_payments: only ('Cash','CASH') and
// ('QR','OTHER') have ever occurred. 'khqr' is our own internal code for the
// national QR scheme, which Loyverse itself just calls 'QR'/'OTHER' — there
// is no third method (e.g. bank transfer) with any historical precedent, so
// none is offered here.
const PAYMENT_METHODS = {
  cash: { payment_name: 'Cash', payment_type: 'CASH' },
  khqr: { payment_name: 'QR',   payment_type: 'OTHER' },
};

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Strict numeric-id parsing — parseInt("12abc") silently returns 12, which
// would let garbage route params slip through.
function parseId(raw) {
  return /^\d+$/.test(String(raw ?? '')) ? parseInt(raw, 10) : null;
}

function tooLong(str, max) {
  return typeof str === 'string' && str.length > max;
}

// Cached (like /catalog) rather than queried on every order create — the
// set of dining options actually used in receipts changes rarely.
let diningOptionsCache = null; // { options: Set, expiresAt }

async function getValidDiningOptions() {
  const now = Date.now();
  if (diningOptionsCache && diningOptionsCache.expiresAt > now) return diningOptionsCache.options;
  const { rows } = await pool.query(
    `SELECT DISTINCT dining_option FROM receipts WHERE dining_option IS NOT NULL`
  );
  const options = new Set(rows.map(r => r.dining_option));
  diningOptionsCache = { options, expiresAt: now + CATALOG_TTL_MS };
  return options;
}

async function loadCatalog() {
  const [categoriesRes, itemsRes] = await Promise.all([
    pool.query(`
      SELECT id, COALESCE(custom_name, name) AS name
      FROM categories
      WHERE deleted_at IS NULL
      ORDER BY name
    `),
    pool.query(`
      SELECT id, COALESCE(custom_name, name) AS name, price,
             COALESCE(custom_category_id, category_id) AS category_id
      FROM items
      WHERE deleted_at IS NULL AND price > 0
      ORDER BY name
    `),
  ]);

  return {
    categories: categoriesRes.rows.map((c, i) => ({ id: c.id, name: c.name, sort: i })),
    items: itemsRes.rows.map(it => ({
      id: it.id, name: it.name, price: Number(it.price), category_id: it.category_id,
    })),
  };
}

async function fetchOrder(id) {
  const orderRes = await pool.query(`SELECT * FROM pos_orders WHERE id = $1`, [id]);
  if (!orderRes.rows.length) return null;
  const itemsRes = await pool.query(
    `SELECT id, source_item_id, item_name, price, quantity, note, kitchen_status
     FROM pos_order_items WHERE order_id = $1 ORDER BY id`,
    [id]
  );
  return { ...orderRes.rows[0], items: itemsRes.rows };
}

// Validates + snapshots a requested line-item list against the live catalog,
// inside the caller's transaction. Throws (400) on any invalid line.
async function snapshotItems(client, items) {
  const out = [];
  for (const line of items) {
    const qty = parseInt(line.quantity, 10);
    if (!line.source_item_id || !Number.isInteger(qty) || qty < 1 || qty > 100) {
      throw httpError(400, 'Each item needs a valid source_item_id and quantity between 1 and 100.');
    }
    if (tooLong(line.note, 200)) throw httpError(400, 'Item note is too long (max 200 characters).');
    const itemRes = await client.query(
      `SELECT id, COALESCE(custom_name, name) AS name, price
       FROM items WHERE id = $1 AND deleted_at IS NULL AND price > 0`,
      [line.source_item_id]
    );
    if (!itemRes.rows.length) throw httpError(400, `Item ${line.source_item_id} is not available.`);
    out.push({
      source_item_id: itemRes.rows[0].id,
      name: itemRes.rows[0].name,
      price: Number(itemRes.rows[0].price),
      quantity: qty,
      note: line.note || null,
    });
  }
  return out;
}

router.get('/catalog', requireTerminalAuth(['pos']), async (req, res) => {
  try {
    const now = Date.now();
    const forceRefresh = req.query.refresh === '1';

    if (!forceRefresh && catalogCache && catalogCache.expiresAt > now) {
      res.set('X-Catalog-Cache', 'hit');
      return res.json(catalogCache.data);
    }

    const data = await loadCatalog();
    catalogCache = { data, expiresAt: now + CATALOG_TTL_MS };
    res.set('X-Catalog-Cache', 'miss');
    res.json(data);
  } catch (err) {
    console.error('POS catalog GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/catalog/version', requireTerminalAuth(['pos']), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM items WHERE deleted_at IS NULL)      AS item_count,
        (SELECT COUNT(*) FROM categories WHERE deleted_at IS NULL) AS category_count,
        GREATEST(
          (SELECT MAX(updated_at) FROM items),
          (SELECT MAX(updated_at) FROM categories)
        ) AS max_updated_at
    `);
    const { item_count, category_count, max_updated_at } = rows[0];
    const fingerprint = `${item_count}:${category_count}:${max_updated_at ? new Date(max_updated_at).getTime() : 0}`;
    const version = crypto.createHash('md5').update(fingerprint).digest('hex').slice(0, 12);
    res.json({ version });
  } catch (err) {
    console.error('POS catalog version GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/config', requireTerminalAuth(['pos']), async (req, res) => {
  try {
    const diningRes = await pool.query(
      `SELECT DISTINCT dining_option FROM receipts WHERE dining_option IS NOT NULL ORDER BY dining_option`
    );
    res.json({
      dining_options: diningRes.rows.map(r => r.dining_option),
      payment_methods: Object.entries(PAYMENT_METHODS).map(([code, v]) => ({
        code, label: v.payment_name, payment_name: v.payment_name, payment_type: v.payment_type,
      })),
    });
  } catch (err) {
    console.error('POS config GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders', requireTerminalAuth(['pos']), async (req, res) => {
  try {
    const { status } = req.query;
    // Always scoped to the calling terminal's own branch -- a cashier at one
    // branch must never see (or accidentally act on) another branch's orders.
    let where  = `WHERE branch_id = $1`;
    let params = [req.terminal.branch_id];
    if (status === 'active') {
      where += ` AND status NOT IN ('paid','cancelled')`;
    } else if (status) {
      where += ` AND status = $2`;
      params.push(status);
    }

    const ordersRes = await pool.query(`SELECT * FROM pos_orders ${where} ORDER BY created_at DESC`, params);
    const ids = ordersRes.rows.map(o => o.id);

    const itemsByOrder = {};
    if (ids.length) {
      const itemsRes = await pool.query(
        `SELECT * FROM pos_order_items WHERE order_id = ANY($1) ORDER BY id`,
        [ids]
      );
      for (const it of itemsRes.rows) {
        (itemsByOrder[it.order_id] ??= []).push(it);
      }
    }

    res.json({ orders: ordersRes.rows.map(o => ({ ...o, items: itemsByOrder[o.id] || [] })) });
  } catch (err) {
    console.error('POS orders GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/:id', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });
  try {
    const order = await fetchOrder(id);
    if (!order || order.branch_id !== req.terminal.branch_id) {
      return res.status(404).json({ message: 'Order not found.' });
    }
    res.json({ order });
  } catch (err) {
    console.error('POS get order error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/orders', requireTerminalAuth(['pos']), async (req, res) => {
  const { dining_option, table_number, discount, items } = req.body;
  if (!dining_option) return res.status(400).json({ message: 'dining_option is required.' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'At least one item is required.' });
  }
  if (tooLong(table_number, 20)) return res.status(400).json({ message: 'table_number is too long (max 20 characters).' });
  if (discount !== undefined && !Number.isFinite(Number(discount))) {
    return res.status(400).json({ message: 'discount must be a number.' });
  }

  const validDining = await getValidDiningOptions();
  if (!validDining.has(dining_option)) {
    return res.status(400).json({ message: 'Unknown dining_option.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lines = await snapshotItems(client, items);
    const subtotal   = lines.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const discountAmt = Math.max(0, Number(discount) || 0);
    const total      = Math.max(0, subtotal - discountAmt);

    const orderNumber = await generateOrderNumber(client);
    const now = toCambodiaTime(new Date());

    const orderRes = await client.query(`
      INSERT INTO pos_orders
        (order_number, status, dining_option, table_number, subtotal, discount, total, created_by, created_at, updated_at, terminal_id, branch_id)
      VALUES ($1,'sent_to_kitchen',$2,$3,$4,$5,$6,$7,$8,$8,$9,$10)
      RETURNING *
    `, [orderNumber, dining_option, table_number || null, subtotal, discountAmt, total, req.terminal.terminal_id, now, req.terminal.id, req.terminal.branch_id]);

    const order = orderRes.rows[0];

    for (const line of lines) {
      await client.query(`
        INSERT INTO pos_order_items (order_id, source_item_id, item_name, price, quantity, note)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [order.id, line.source_item_id, line.name, line.price, line.quantity, line.note]);
    }

    await client.query(
      `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'created',$2,$3)`,
      [order.id, req.terminal.terminal_id, now]
    );
    await client.query(
      `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'sent_to_kitchen',$2,$3)`,
      [order.id, req.terminal.terminal_id, now]
    );

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.status(201).json({ order: await fetchOrder(order.id) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS create order error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
});

router.post('/orders/:id/items', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  const { items } = req.body;
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'At least one item is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query('SELECT * FROM pos_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!orderRes.rows.length) throw httpError(404, 'Order not found.');
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');
    if (TERMINAL.has(order.status)) throw httpError(409, `Cannot add items to a ${order.status} order.`);

    const lines = await snapshotItems(client, items);
    for (const line of lines) {
      await client.query(`
        INSERT INTO pos_order_items (order_id, source_item_id, item_name, price, quantity, note)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [id, line.source_item_id, line.name, line.price, line.quantity, line.note]);
    }

    const addedSubtotal = lines.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const newSubtotal   = Number(order.subtotal) + addedSubtotal;
    const newTotal      = Math.max(0, newSubtotal - Number(order.discount));
    const now = toCambodiaTime(new Date());

    await client.query(
      `UPDATE pos_orders SET subtotal = $1, total = $2, updated_at = $3 WHERE id = $4`,
      [newSubtotal, newTotal, now, id]
    );

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(id) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS append items error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
});

router.post('/orders/:id/pay', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  const { payment_method, cash_received } = req.body;
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });
  if (!PAYMENT_METHODS[payment_method]) return res.status(400).json({ message: 'Unknown payment_method.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query('SELECT * FROM pos_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!orderRes.rows.length) throw httpError(404, 'Order not found.');
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');
    if (!canTransition(order.status, 'paid')) throw httpError(409, `Cannot pay a ${order.status} order.`);

    let cashReceivedVal = null;
    if (payment_method === 'cash') {
      cashReceivedVal = Number(cash_received);
      if (!Number.isFinite(cashReceivedVal) || cashReceivedVal < Number(order.total)) {
        throw httpError(400, 'cash_received must be a number >= total.');
      }
    }

    const now = toCambodiaTime(new Date());
    await client.query(`
      UPDATE pos_orders SET status = 'paid', payment_method = $1, cash_received = $2, paid_at = $3, updated_at = $3
      WHERE id = $4
    `, [payment_method, cashReceivedVal, now, id]);

    await client.query(
      `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'paid',$2,$3)`,
      [id, req.terminal.terminal_id, now]
    );

    await client.query('COMMIT');
    broadcastOrdersChanged();
    const change = payment_method === 'cash' ? Number((cashReceivedVal - Number(order.total)).toFixed(0)) : 0;
    res.json({ order: await fetchOrder(id), change });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS pay error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
});

router.post('/orders/:id/cancel', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = req.body;
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });
  if (tooLong(reason, 200)) return res.status(400).json({ message: 'reason is too long (max 200 characters).' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query('SELECT * FROM pos_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!orderRes.rows.length) throw httpError(404, 'Order not found.');
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');
    if (!canTransition(order.status, 'cancelled')) throw httpError(409, `Cannot cancel a ${order.status} order.`);

    const now = toCambodiaTime(new Date());
    await client.query(
      `UPDATE pos_orders SET status = 'cancelled', cancelled_at = $1, cancel_reason = $2, updated_at = $1 WHERE id = $3`,
      [now, reason || null, id]
    );
    await client.query(
      `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'cancelled',$2,$3)`,
      [id, req.terminal.terminal_id, now]
    );

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(id) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS cancel error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
});

// ── Kitchen Display System (Phase 4) ────────────────────────────────────

router.get('/kds/active', requireTerminalAuth(['kds']), async (req, res) => {
  try {
    // Zero categories assigned means this station hasn't been configured yet
    // -- show a friendly empty state, never "all orders" as a fallback.
    const catRes = await pool.query(
      `SELECT category_id FROM kds_terminal_categories WHERE kds_terminal_id = $1`,
      [req.terminal.id]
    );
    const categoryIds = catRes.rows.map(r => r.category_id);
    if (!categoryIds.length) {
      return res.json({ server_now: toCambodiaTime(new Date()), orders: [], no_categories_assigned: true });
    }

    const ordersRes = await pool.query(
      `SELECT * FROM pos_orders
       WHERE status IN ('sent_to_kitchen','preparing','ready') AND branch_id = $1
       ORDER BY created_at ASC`,
      [req.terminal.branch_id]
    );
    const ids = ordersRes.rows.map(o => o.id);

    const itemsByOrder = {};
    if (ids.length) {
      // Only items whose (custom-overridden) category is assigned to this
      // KDS station -- an order can appear on multiple stations at once,
      // each showing a different subset of its items.
      const itemsRes = await pool.query(
        `SELECT poi.*
         FROM pos_order_items poi
         JOIN items i ON i.id = poi.source_item_id::uuid
         WHERE poi.order_id = ANY($1)
           AND COALESCE(i.custom_category_id, i.category_id) = ANY($2::uuid[])
         ORDER BY poi.id`,
        [ids, categoryIds]
      );
      for (const it of itemsRes.rows) {
        (itemsByOrder[it.order_id] ??= []).push(it);
      }
    }

    const orders = ordersRes.rows
      .map(o => ({ ...o, items: itemsByOrder[o.id] || [] }))
      .filter(o => o.items.length > 0);

    res.json({ server_now: toCambodiaTime(new Date()), orders });
  } catch (err) {
    console.error('POS kds active GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// EventSource has no way to attach headers, so auth here comes from a
// `?token=` query param instead of the usual Authorization header.
router.get('/kds/stream', async (req, res) => {
  try {
    await verifyTerminalToken(req.query.token || '', ['kds']);
  } catch {
    return res.status(401).end();
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  kdsClients.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    kdsClients.delete(res);
  });
});

router.patch('/order-items/:id/kitchen-status', requireTerminalAuth(['kds']), async (req, res) => {
  const id = parseId(req.params.id);
  const { status } = req.body;
  if (!id) return res.status(400).json({ message: 'Invalid item id.' });
  if (!ITEM_KITCHEN_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'status must be one of pending, preparing, done.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itemRes = await client.query('SELECT * FROM pos_order_items WHERE id = $1 FOR UPDATE', [id]);
    if (!itemRes.rows.length) throw httpError(404, 'Order item not found.');
    const item = itemRes.rows[0];

    const orderRes = await client.query('SELECT * FROM pos_orders WHERE id = $1 FOR UPDATE', [item.order_id]);
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order item not found.');
    if (TERMINAL.has(order.status)) throw httpError(409, `Cannot update items on a ${order.status} order.`);

    await client.query('UPDATE pos_order_items SET kitchen_status = $1 WHERE id = $2', [status, id]);

    // Kitchen starting work on any line bumps the order itself into
    // 'preparing' so the order-level state machine can later advance to
    // 'ready' (order status and per-item kitchen_status are otherwise
    // independent tracks).
    const now = toCambodiaTime(new Date());
    if (order.status === 'sent_to_kitchen' && status !== 'pending') {
      await client.query('UPDATE pos_orders SET status = $1, updated_at = $2 WHERE id = $3', ['preparing', now, order.id]);
    } else {
      await client.query('UPDATE pos_orders SET updated_at = $1 WHERE id = $2', [now, order.id]);
    }

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(order.id) });
  } catch (err) {
    await client.query('ROLLBACK');
    const statusCode = err.statusCode || 500;
    if (statusCode >= 500) console.error('POS kitchen-status error:', err);
    res.status(statusCode).json({ message: err.message });
  } finally {
    client.release();
  }
});

router.post('/orders/:id/ready', requireTerminalAuth(['kds']), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query('SELECT * FROM pos_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!orderRes.rows.length) throw httpError(404, 'Order not found.');
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');
    if (!canTransition(order.status, 'ready')) throw httpError(409, `Cannot mark a ${order.status} order ready.`);

    const itemsRes = await client.query('SELECT kitchen_status FROM pos_order_items WHERE order_id = $1', [id]);
    if (itemsRes.rows.some(i => i.kitchen_status !== 'done')) {
      throw httpError(409, 'All items must be done before marking the order ready.');
    }

    const now = toCambodiaTime(new Date());
    await client.query('UPDATE pos_orders SET status = $1, updated_at = $2 WHERE id = $3', ['ready', now, id]);
    await client.query(
      `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'ready',$2,$3)`,
      [id, req.terminal.terminal_id, now]
    );

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(id) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS ready error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
});

router.post('/orders/:id/served', requireTerminalAuth(['kds']), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query('SELECT * FROM pos_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!orderRes.rows.length) throw httpError(404, 'Order not found.');
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');
    if (!canTransition(order.status, 'served')) throw httpError(409, `Cannot mark a ${order.status} order served.`);

    const now = toCambodiaTime(new Date());
    await client.query('UPDATE pos_orders SET status = $1, updated_at = $2 WHERE id = $3', ['served', now, id]);
    await client.query(
      `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'served',$2,$3)`,
      [id, req.terminal.terminal_id, now]
    );

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(id) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS served error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
});

// Unauthenticated liveness/readiness probe — monitoring tools shouldn't need
// a JWT, and it only ever reveals db-reachable + process uptime.
router.get('/health', async (req, res) => {
  let db = 'ok';
  try {
    await pool.query('SELECT 1');
  } catch {
    db = 'down';
  }
  res.json({ db, uptime: process.uptime() });
});

module.exports = router;

const crypto  = require('crypto');
const router  = require('express').Router();
const pool    = require('../db');
const { requireTerminalAuth, verifyTerminalToken } = require('../middleware/terminalAuth');
const { toCambodiaTime } = require('../utils/date');
const { generateOrderNumber } = require('../services/pos/orderNumber');
const { generateReceiptNumber } = require('../services/pos/receiptNumber');
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

// Only dine-in-shaped value seen in receipts.dining_option on this branch's
// data. No admin-configurable flag -- accepted tradeoff, see plan doc.
const DINE_IN_LABEL = 'ក្នុងហាង';

// "Active" here matches the definition already used by GET /orders?status=active
// (status NOT IN ('paid','cancelled')) -- a table number frees up once its
// order is paid or cancelled. Best-effort check-then-write, same pattern as
// every other validation in this file; no DB-level uniqueness constraint.
async function assertTableNumberAvailable(dbClient, branchId, tableNumber, excludeOrderId) {
  const { rows } = await dbClient.query(
    `SELECT id FROM pos_orders
     WHERE branch_id = $1 AND table_number = $2 AND status NOT IN ('paid','cancelled')
       AND id IS DISTINCT FROM $3
     LIMIT 1`,
    [branchId, tableNumber, excludeOrderId || null]
  );
  if (rows.length) throw httpError(409, `Table ${tableNumber} already has an active order.`);
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
      SELECT id, COALESCE(custom_name, name) AS name, price, image_url,
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
      image_url: it.image_url || null,
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
  const { dining_option, table_number, discount, items, name } = req.body;
  if (!dining_option) return res.status(400).json({ message: 'dining_option is required.' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'At least one item is required.' });
  }
  if (tooLong(table_number, 20)) return res.status(400).json({ message: 'table_number is too long (max 20 characters).' });
  if (tooLong(name, 100)) return res.status(400).json({ message: 'name is too long (max 100 characters).' });
  if (discount !== undefined && !Number.isFinite(Number(discount))) {
    return res.status(400).json({ message: 'discount must be a number.' });
  }

  const validDining = await getValidDiningOptions();
  if (!validDining.has(dining_option)) {
    return res.status(400).json({ message: 'Unknown dining_option.' });
  }

  const tableNum = (table_number || '').trim() || null;
  if (dining_option === DINE_IN_LABEL && !tableNum) {
    return res.status(400).json({ message: 'table_number is required for dine-in orders.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (tableNum) await assertTableNumberAvailable(client, req.terminal.branch_id, tableNum, null);

    const lines = await snapshotItems(client, items);
    const subtotal   = lines.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const discountAmt = Math.max(0, Number(discount) || 0);
    const total      = Math.max(0, subtotal - discountAmt);

    const orderNumber = await generateOrderNumber(client);
    const now = toCambodiaTime(new Date());

    // Saved as 'open' -- not yet visible to KDS. The client immediately
    // follows up with POST /orders/:id/send-to-kitchen; if that fails, the
    // order is still safely saved and can be retried or added to later.
    const orderRes = await client.query(`
      INSERT INTO pos_orders
        (order_number, status, dining_option, table_number, subtotal, discount, total, created_by, created_at, updated_at, terminal_id, branch_id, name)
      VALUES ($1,'open',$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11)
      RETURNING *
    `, [orderNumber, dining_option, tableNum, subtotal, discountAmt, total, req.terminal.terminal_id, now, req.terminal.id, req.terminal.branch_id, name || null]);

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

// Separated from creation so the client can auto-attempt this right after
// saving, but retry it independently (manually or via the offline queue) if
// just this step fails -- the order itself is never lost.
router.post('/orders/:id/send-to-kitchen', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query('SELECT * FROM pos_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!orderRes.rows.length) throw httpError(404, 'Order not found.');
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');

    // Idempotent: a retried send against an order that's already past
    // 'open' (e.g. the previous attempt actually succeeded but its response
    // was lost) just returns the current order instead of erroring.
    if (order.status !== 'open') {
      if (order.status === 'cancelled') throw httpError(409, 'Cannot send a cancelled order to the kitchen.');
      await client.query('COMMIT');
      return res.json({ order: await fetchOrder(id) });
    }

    const now = toCambodiaTime(new Date());
    await client.query(`UPDATE pos_orders SET status = 'sent_to_kitchen', sent_to_kitchen_at = $1, updated_at = $1 WHERE id = $2`, [now, id]);
    await client.query(
      `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'sent_to_kitchen',$2,$3)`,
      [id, req.terminal.terminal_id, now]
    );

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(id) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS send-to-kitchen error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
});

router.patch('/orders/:id/name', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });
  const { name } = req.body;
  if (tooLong(name, 100)) return res.status(400).json({ message: 'name is too long (max 100 characters).' });

  try {
    const result = await pool.query(
      `UPDATE pos_orders SET name = $1, updated_at = $2 WHERE id = $3 AND branch_id = $4 RETURNING id`,
      [(name || '').trim() || null, toCambodiaTime(new Date()), id, req.terminal.branch_id]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'Order not found.' });
    res.json({ order: await fetchOrder(id) });
  } catch (err) {
    console.error('POS order rename error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Dining option is changeable any time the order isn't already finished --
// e.g. a cashier building a saved order can still switch dine-in/takeaway
// after items are already on it.
router.patch('/orders/:id/dining-option', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });
  const { dining_option } = req.body;
  if (!dining_option) return res.status(400).json({ message: 'dining_option is required.' });

  const validDining = await getValidDiningOptions();
  if (!validDining.has(dining_option)) {
    return res.status(400).json({ message: 'Unknown dining_option.' });
  }

  try {
    const orderRes = await pool.query('SELECT status, branch_id FROM pos_orders WHERE id = $1', [id]);
    if (!orderRes.rows.length || orderRes.rows[0].branch_id !== req.terminal.branch_id) {
      return res.status(404).json({ message: 'Order not found.' });
    }
    if (TERMINAL.has(orderRes.rows[0].status)) {
      return res.status(409).json({ message: `Cannot change dining option on a ${orderRes.rows[0].status} order.` });
    }

    await pool.query(
      `UPDATE pos_orders SET dining_option = $1, updated_at = $2 WHERE id = $3`,
      [dining_option, toCambodiaTime(new Date()), id]
    );
    res.json({ order: await fetchOrder(id) });
  } catch (err) {
    console.error('POS dining-option error:', err);
    res.status(500).json({ error: err.message });
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

router.patch('/order-items/:id', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  const qty = parseInt(req.body.quantity, 10);
  if (!id) return res.status(400).json({ message: 'Invalid item id.' });
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
    return res.status(400).json({ message: 'quantity must be a number between 1 and 100.' });
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
    if (TERMINAL.has(order.status)) throw httpError(409, `Cannot edit items on a ${order.status} order.`);
    if (item.kitchen_status === 'done') throw httpError(409, "This item has already been prepared and can't be changed.");

    await client.query('UPDATE pos_order_items SET quantity = $1 WHERE id = $2', [qty, id]);

    const itemsRes  = await client.query('SELECT price, quantity FROM pos_order_items WHERE order_id = $1', [order.id]);
    const newSubtotal = itemsRes.rows.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
    const newTotal     = Math.max(0, newSubtotal - Number(order.discount));
    const now = toCambodiaTime(new Date());
    await client.query(
      `UPDATE pos_orders SET subtotal = $1, total = $2, updated_at = $3 WHERE id = $4`,
      [newSubtotal, newTotal, now, order.id]
    );

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(order.id) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS order-item quantity error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
});

router.delete('/order-items/:id', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid item id.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itemRes = await client.query('SELECT * FROM pos_order_items WHERE id = $1 FOR UPDATE', [id]);
    if (!itemRes.rows.length) throw httpError(404, 'Order item not found.');
    const item = itemRes.rows[0];

    const orderRes = await client.query('SELECT * FROM pos_orders WHERE id = $1 FOR UPDATE', [item.order_id]);
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order item not found.');
    if (TERMINAL.has(order.status)) throw httpError(409, `Cannot edit items on a ${order.status} order.`);
    if (item.kitchen_status === 'done') throw httpError(409, "This item has already been prepared and can't be removed.");

    const countRes = await client.query('SELECT COUNT(*) AS n FROM pos_order_items WHERE order_id = $1', [order.id]);
    if (parseInt(countRes.rows[0].n, 10) <= 1) {
      throw httpError(409, 'Cannot remove the last item — cancel the order instead.');
    }

    await client.query('DELETE FROM pos_order_items WHERE id = $1', [id]);

    const itemsRes  = await client.query('SELECT price, quantity FROM pos_order_items WHERE order_id = $1', [order.id]);
    const newSubtotal = itemsRes.rows.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
    const newTotal     = Math.max(0, newSubtotal - Number(order.discount));
    const now = toCambodiaTime(new Date());
    await client.query(
      `UPDATE pos_orders SET subtotal = $1, total = $2, updated_at = $3 WHERE id = $4`,
      [newSubtotal, newTotal, now, order.id]
    );

    const allItemsRes = await client.query(`
      SELECT poi.kitchen_status
      FROM pos_order_items poi
      JOIN items i ON i.id = poi.source_item_id::uuid
      WHERE poi.order_id = $1
        AND EXISTS (
          SELECT 1 FROM kds_terminal_categories ktc
          WHERE ktc.category_id = COALESCE(i.custom_category_id, i.category_id)
        )
    `, [order.id]);
    const allDone = allItemsRes.rows.length > 0 && allItemsRes.rows.every(i => i.kitchen_status === 'done');
    if (allDone && order.status !== 'ready' && order.status !== 'served' && !TERMINAL.has(order.status)) {
      await client.query('UPDATE pos_orders SET status = $1, updated_at = $2 WHERE id = $3', ['ready', now, order.id]);
      await client.query(
        `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'ready',$2,$3)`,
        [order.id, req.terminal.terminal_id, now]
      );
    }

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(order.id) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS order-item delete error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
});

async function completeOrder(req, res) {
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

    // Immutable financial record -- written once here, never updated again.
    // A refund later inserts its own new row (routes/receipts.js), it never
    // touches this one.
    const receiptNumber = await generateReceiptNumber(client);
    const pm = PAYMENT_METHODS[payment_method];
    const receiptRes = await client.query(`
      INSERT INTO pos_receipts
        (receipt_number, order_id, branch_id, pos_terminal_id, dining_option, subtotal, discount, total, receipt_date, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
    `, [receiptNumber, order.id, order.branch_id, req.terminal.id, order.dining_option,
        order.subtotal, order.discount, order.total, now, req.terminal.terminal_id]);
    const receiptId = receiptRes.rows[0].id;

    await client.query(`
      INSERT INTO pos_receipt_items (receipt_id, sku, item_name, quantity, price, gross_total)
      SELECT $1, it.sku, poi.item_name, poi.quantity, poi.price, poi.price * poi.quantity
      FROM pos_order_items poi
      LEFT JOIN items it ON it.id = poi.source_item_id::uuid
      WHERE poi.order_id = $2
    `, [receiptId, order.id]);

    await client.query(`
      INSERT INTO pos_receipt_payments (receipt_id, payment_name, payment_type, money_amount, paid_at)
      VALUES ($1,$2,$3,$4,$5)
    `, [receiptId, pm.payment_name, pm.payment_type, order.total, now]);

    await client.query(`UPDATE pos_orders SET receipt_id = $1 WHERE id = $2`, [receiptId, id]);

    await client.query(
      `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'paid',$2,$3)`,
      [id, req.terminal.terminal_id, now]
    );

    await client.query('COMMIT');
    broadcastOrdersChanged();
    const change = payment_method === 'cash' ? Number((cashReceivedVal - Number(order.total)).toFixed(0)) : 0;
    res.json({ order: await fetchOrder(id), receipt_number: receiptNumber, change });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS complete order error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
}

router.post('/orders/:id/pay',      requireTerminalAuth(['pos']), completeOrder);
router.post('/orders/:id/complete', requireTerminalAuth(['pos']), completeOrder);

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

    const doneItemsRes = await client.query(
      `SELECT 1 FROM pos_order_items WHERE order_id = $1 AND kitchen_status = 'done' LIMIT 1`,
      [id]
    );
    if (doneItemsRes.rows.length) {
      throw httpError(409, 'Cannot cancel — some items are already prepared. Use a refund from the dashboard instead.');
    }

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

async function loadKdsCategoryIds(kdsTerminalId) {
  const catRes = await pool.query(
    `SELECT category_id FROM kds_terminal_categories WHERE kds_terminal_id = $1`,
    [kdsTerminalId]
  );
  return catRes.rows.map(r => r.category_id);
}

async function loadKdsDisplaySettings() {
  const res = await pool.query('SELECT warn_minutes, danger_minutes FROM kds_display_settings ORDER BY id LIMIT 1');
  return res.rows[0] || { warn_minutes: 10, danger_minutes: 20 };
}

// Only items whose (custom-overridden) category is assigned to this KDS
// station -- an order can appear on multiple stations at once, each showing
// a different subset of its items. Orders with no matching items at all are
// dropped entirely (nothing on this board belongs to this station).
async function attachFilteredItems(orders, categoryIds) {
  const ids = orders.map(o => o.id);
  const itemsByOrder = {};
  if (ids.length) {
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
  return orders.map(o => ({ ...o, items: itemsByOrder[o.id] || [] })).filter(o => o.items.length > 0);
}

router.get('/kds/active', requireTerminalAuth(['kds']), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    // Zero categories assigned means this station hasn't been configured yet
    // -- show a friendly empty state, never "all orders" as a fallback.
    const categoryIds = await loadKdsCategoryIds(req.terminal.id);
    const settings = await loadKdsDisplaySettings();
    if (!categoryIds.length) {
      return res.json({ server_now: new Date().toISOString(), orders: [], no_categories_assigned: true, ...settings });
    }

    const ordersRes = await pool.query(
      `SELECT * FROM pos_orders
       WHERE status IN ('sent_to_kitchen','preparing','ready') AND branch_id = $1
       ORDER BY created_at ASC`,
      [req.terminal.branch_id]
    );
    const orders = await attachFilteredItems(ordersRes.rows, categoryIds);
    res.json({ server_now: new Date().toISOString(), orders, ...settings });
  } catch (err) {
    console.error('POS kds active GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Read-only lookback at recently completed (served) orders for this
// station -- lets kitchen staff double-check what already went out without
// cluttering the live board. Rolling 24-hour window on served_at (Cambodia-
// naive like every other timestamp on this table, see migrations/008 --
// compared against NOW() AT TIME ZONE, never bare NOW()), most-recent-first,
// with a defensive cap that's not expected to bind at real single-branch
// 24h volumes.
router.get('/kds/finished', requireTerminalAuth(['kds']), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const categoryIds = await loadKdsCategoryIds(req.terminal.id);
    const settings = await loadKdsDisplaySettings();
    if (!categoryIds.length) {
      return res.json({ server_now: new Date().toISOString(), orders: [], no_categories_assigned: true, ...settings });
    }

    const ordersRes = await pool.query(
      `SELECT * FROM pos_orders
       WHERE status = 'served' AND branch_id = $1
         AND served_at >= (NOW() AT TIME ZONE 'Asia/Phnom_Penh') - INTERVAL '24 hours'
       ORDER BY served_at DESC
       LIMIT 200`,
      [req.terminal.branch_id]
    );
    const orders = await attachFilteredItems(ordersRes.rows, categoryIds);
    res.json({ server_now: new Date().toISOString(), orders, ...settings });
  } catch (err) {
    console.error('POS kds finished GET error:', err);
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

    const now = toCambodiaTime(new Date());
    // Every item across the WHOLE order (any KDS station) done -- auto-advance
    // to ready regardless of which station struck the last one, so readiness
    // never depends on someone remembering to tap the Ready button.
    const allItemsRes = await client.query(`
      SELECT poi.kitchen_status
      FROM pos_order_items poi
      JOIN items i ON i.id = poi.source_item_id::uuid
      WHERE poi.order_id = $1
        AND EXISTS (
          SELECT 1 FROM kds_terminal_categories ktc
          WHERE ktc.category_id = COALESCE(i.custom_category_id, i.category_id)
        )
    `, [order.id]);
    const allDone = allItemsRes.rows.length > 0 && allItemsRes.rows.every(i => i.kitchen_status === 'done');

    if (allDone && order.status !== 'ready' && order.status !== 'served' && !TERMINAL.has(order.status)) {
      await client.query('UPDATE pos_orders SET status = $1, updated_at = $2 WHERE id = $3', ['ready', now, order.id]);
      await client.query(
        `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'ready',$2,$3)`,
        [order.id, req.terminal.terminal_id, now]
      );
    } else if (order.status === 'sent_to_kitchen' && status !== 'pending') {
      // Kitchen starting work on any line bumps the order itself into
      // 'preparing' so the order-level state machine can later advance to
      // 'ready' (order status and per-item kitchen_status are otherwise
      // independent tracks).
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
    if (TERMINAL.has(order.status)) throw httpError(409, `Cannot mark a ${order.status} order ready.`);
    if (order.status === 'ready' || order.status === 'served') {
      // Already fully ready -- another station's tap (or the last item
      // struck anywhere) already got there first. Idempotent no-op.
      await client.query('COMMIT');
      return res.json({ order: await fetchOrder(id), fully_ready: true });
    }

    // Only THIS station's own items must be done -- exactly what the
    // client's Ready button already checks before it's enabled. A station
    // must never be blocked by another station's still-pending items.
    const categoryIds = await loadKdsCategoryIds(req.terminal.id);
    const stationItemsRes = await client.query(`
      SELECT poi.kitchen_status
      FROM pos_order_items poi
      JOIN items i ON i.id = poi.source_item_id::uuid
      WHERE poi.order_id = $1
        AND COALESCE(i.custom_category_id, i.category_id) = ANY($2::uuid[])
    `, [id, categoryIds]);
    if (!stationItemsRes.rows.length) {
      throw httpError(409, 'No items on this order belong to your station.');
    }
    if (stationItemsRes.rows.some(i => i.kitchen_status !== 'done')) {
      throw httpError(409, 'Your items must be done before marking your part ready.');
    }

    const now = toCambodiaTime(new Date());
    const allItemsRes = await client.query(`
      SELECT poi.kitchen_status
      FROM pos_order_items poi
      JOIN items i ON i.id = poi.source_item_id::uuid
      WHERE poi.order_id = $1
        AND EXISTS (
          SELECT 1 FROM kds_terminal_categories ktc
          WHERE ktc.category_id = COALESCE(i.custom_category_id, i.category_id)
        )
    `, [id]);
    const fullyReady = allItemsRes.rows.length > 0 && allItemsRes.rows.every(i => i.kitchen_status === 'done');

    if (fullyReady) {
      await client.query('UPDATE pos_orders SET status = $1, updated_at = $2 WHERE id = $3', ['ready', now, id]);
      await client.query(
        `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'ready',$2,$3)`,
        [id, req.terminal.terminal_id, now]
      );
    }
    // else: this station's part is done, but other station(s) still have
    // pending items -- no status change, order stays visible everywhere.

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(id), fully_ready: fullyReady });
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
    await client.query('UPDATE pos_orders SET status = $1, served_at = $2, updated_at = $2 WHERE id = $3', ['served', now, id]);
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

router.get('/receipts', requireTerminalAuth(['pos']), async (req, res) => {
  try {
    let date = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) {
      // The regex only checks shape -- a value like 2026-13-45 still needs
      // Date to confirm it's a real calendar date before it reaches SQL,
      // where an out-of-range date/time value raises a raw pg error (22008).
      const parsed = new Date(`${req.query.date}T00:00:00Z`);
      if (!isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === req.query.date) {
        date = req.query.date;
      }
    }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const params = [req.terminal.branch_id];
    let where = 'WHERE r.branch_id = $1';
    if (date) { where += ' AND DATE(r.receipt_date) = $2'; params.push(date); }
    else      { where += ` AND DATE(r.receipt_date) = (NOW() AT TIME ZONE 'Asia/Phnom_Penh')::date`; }
    params.push(limit);

    const { rows } = await pool.query(`
      SELECT r.id, r.receipt_number, r.dining_option, r.subtotal, r.discount, r.total,
             r.receipt_date, r.cancelled_at, r.created_by,
             o.order_number, o.table_number, o.name AS order_name
      FROM pos_receipts r
      JOIN pos_orders o ON o.id = r.order_id
      ${where}
      ORDER BY r.receipt_date DESC
      LIMIT $${params.length}
    `, params);
    res.json({ receipts: rows });
  } catch (err) {
    console.error('POS receipts GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/receipts/:id', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid receipt id.' });
  try {
    const { rows } = await pool.query(`
      SELECT r.*, o.order_number, o.table_number, o.name AS order_name
      FROM pos_receipts r JOIN pos_orders o ON o.id = r.order_id
      WHERE r.id = $1 AND r.branch_id = $2
    `, [id, req.terminal.branch_id]);
    if (!rows.length) return res.status(404).json({ message: 'Receipt not found.' });
    const receipt = rows[0];

    const [itemsRes, payRes] = await Promise.all([
      pool.query(`SELECT sku, item_name, quantity, price, gross_total FROM pos_receipt_items WHERE receipt_id = $1 ORDER BY id`, [id]),
      pool.query(`SELECT payment_name, payment_type, money_amount, paid_at FROM pos_receipt_payments WHERE receipt_id = $1 ORDER BY id`, [id]),
    ]);
    receipt.items = itemsRes.rows;
    receipt.payment = payRes.rows[0] || null;
    res.json({ receipt });
  } catch (err) {
    console.error('POS receipt detail GET error:', err);
    res.status(500).json({ error: err.message });
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
module.exports.DINE_IN_LABEL = DINE_IN_LABEL;
module.exports.assertTableNumberAvailable = assertTableNumberAvailable;

const crypto  = require('crypto');
const router  = require('express').Router();
const pool    = require('../db');
const { requireTerminalAuth, requireTerminalRole, verifySessionToken } = require('../middleware/terminalAuth');
const { requireCsrf } = require('../middleware/terminalCsrf');
const { toCambodiaTime, formatCambodiaClockTime } = require('../utils/date');
const { generateOrderNumber } = require('../services/pos/orderNumber');
const { generateReceiptNumber } = require('../services/pos/receiptNumber');
const { canTransition, TERMINAL } = require('../services/pos/stateMachine');
const { findIdempotentResponse, recordIdempotentResponse } = require('../services/pos/idempotency');
const { resolveActionTime } = require('../services/pos/offlineClock');
const config = require('../config');

const CATALOG_TTL_MS = 60 * 1000;
let catalogCache = null; // { data, expiresAt }

const ITEM_KITCHEN_STATUSES = ['pending', 'preparing', 'done'];

// KDS realtime: server-held list of open SSE connections. EventSource can't
// set custom headers, but it does send cookies automatically on same-origin
// requests (withCredentials: true on the client) -- so /kds/stream reads
// cm_session like any other route instead of taking a token in the URL,
// which would otherwise leak into server logs, proxies, and browser history.
const kdsClients = new Set();

function broadcastOrdersChanged() {
  const payload = `data: ${JSON.stringify({ type: 'orders_changed' })}\n\n`;
  for (const res of kdsClients) {
    // A socket that died without its 'close' handler having fired yet (a
    // common abrupt-WiFi-drop pattern on kitchen tablets) throws on write --
    // one dead client must never take down the broadcast for every other
    // still-connected KDS station.
    try {
      res.write(payload);
    } catch {
      kdsClients.delete(res);
    }
  }
}

// Discovered in Phase 1 from receipt_payments: only ('Cash','CASH') and
// ('QR','OTHER') have ever occurred. 'khqr' is our own internal code for the
// national QR scheme, which Loyverse itself just calls 'QR'/'OTHER'.
const PAYMENT_METHODS = {
  cash: { payment_name: 'Cash', payment_type: 'CASH' },
  khqr: { payment_name: 'QR',   payment_type: 'OTHER' },
};

// 'both' is a split of the two methods above (part cash, part QR) — it has
// no single payment_name/payment_type of its own. completeOrder() below
// writes it as two separate pos_receipt_payments rows, one per method.
const PAYMENT_METHOD_OPTIONS = [
  { code: 'cash', label: 'Cash' },
  { code: 'khqr', label: 'QR' },
  { code: 'both', label: 'Both' },
];

// `code` is an optional machine-readable tag (e.g. ORDER_TERMINAL) so the
// client can react to specific failure shapes -- like an order having become
// paid/cancelled out from under a still-open panel -- without parsing the
// human-readable message text.
function httpError(statusCode, message, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
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

// Non-blocking staleness check (POS revision, 2026-08-02): base_version is
// the version the client last saw for this row; omitted by a live/older
// client, in which case the check is skipped entirely (a live click always
// targets what's currently on screen). A mismatch means the row moved under
// a since-queued edit -- callers apply the write anyway (last-write-wins)
// and flag `notice: true` on the response so the client can toast "this
// order changed elsewhere" instead of silently overwriting with no signal.
// Never rejects.
function isStaleVersion(base_version, currentVersion) {
  return base_version !== undefined && base_version !== null && Number(base_version) !== currentVersion;
}

// ─── Order edit lock (POS revision, 2026-08-03; idle-based 2026-08-05) ──────
// Hard-blocks a second POS terminal from editing/paying/cancelling an order
// while another terminal has it open -- see migration 026. A lock is
// considered gone (safe to claim/ignore) once locked_at is older than
// config.posOrderLockTtlSeconds, so a terminal that drops offline or closes
// its tab mid-edit never strands the order. Supervisor terminals always
// bypass a live lock, same escalation pattern as requireTerminalRole for
// payment.
//
// locked_at is the time of the last real CASHIER ACTION on the order, not a
// liveness heartbeat -- see the config comment. Merely having the order on
// screen no longer holds it; every mutating route below refreshes it via
// touchLock(), and the client re-claims on cart activity. That makes the TTL
// mean exactly what the floor expects: "untouched for 5 minutes = up for
// grabs again".
// How old is this lock? Computed BY POSTGRES, not by JS date math, and every
// query that feeds a lock check must select it (see LOCK_AGE_SQL below).
//
// pos_orders.locked_at is `timestamp WITHOUT time zone`, so `NOW()` stores the
// DB's own wall clock and node-postgres hands the value back as a Date parsed
// in the NODE process's local timezone. On UAT (local Postgres, same machine,
// UTC+7) those agree and JS date math worked. On PROD they do not: Supabase
// runs in UTC, the app server runs in Asia/Phnom_Penh, so a lock written one
// second ago read back as SEVEN HOURS old and was stale the instant it was
// written -- the lock never worked on PROD at all (bug present since migration
// 026; found 2026-08-05). Subtracting inside SQL keeps both operands on the
// database's clock, which is correct no matter where either process runs and
// needs no column-type migration.
const LOCK_AGE_SQL = `EXTRACT(EPOCH FROM (NOW() - locked_at)) AS lock_age_seconds`;

function isLockStale(order) {
  if (!order || !order.locked_at) return true;
  // Fallback for any row fetched by a query that forgot LOCK_AGE_SQL: no
  // worse than the old behavior, and lock-age-columns.test.js asserts no
  // lock-checking route actually relies on it.
  const ageSeconds = order.lock_age_seconds != null
    ? Number(order.lock_age_seconds)
    : (Date.now() - new Date(order.locked_at).getTime()) / 1000;
  return ageSeconds > config.posOrderLockTtlSeconds;
}
// Is this lock held by the CALLER's own session?
//
// Compared by terminal_devices.id, not pos_terminals.id: the lock means "this
// screen has the order open", and two windows/tablets signed in under the
// same terminal code are different screens. Keying on the terminal made them
// indistinguishable -- each read locked_by_terminal_id == its own terminal id,
// decided it already held the lock, and both edited the same order freely
// (migration 027 has the full write-up). Rows locked before 027 have a NULL
// device id; those fall back to the terminal comparison so an in-flight lock
// from before the deploy still behaves sanely rather than instantly looking
// like someone else's.
function isLockMine(order, terminal) {
  if (order.locked_by_device_id != null) return order.locked_by_device_id === terminal.device_id;
  return order.locked_by_terminal_id === terminal.id;
}
// Whether someone ELSE genuinely holds this order right now, ignoring role.
// Supervisor privilege is deliberately NOT folded in here -- see
// assertNotLockedByOther below for why that distinction matters.
function isHeldByOther(order, terminal) {
  if (!order.locked_by_terminal_id && order.locked_by_device_id == null) return false;
  if (isLockMine(order, terminal)) return false;
  return !isLockStale(order);
}
function isLockedByOther(order, terminal) {
  if (terminal.role === 'supervisor') return false;
  return isHeldByOther(order, terminal);
}
// Thrown from inside the same SELECT ... FOR UPDATE transaction every
// mutating route already opens, so the lock check reads the same row the
// TERMINAL-status check just read -- no separate round trip.
//
// A supervisor still passes this unconditionally: once it has force-claimed
// (see POST /orders/:id/claim) it legitimately holds the lock anyway, and
// keeping the bypass here means an emergency override is never wedged shut
// by a stuck lock. The place a HUMAN decides to take an order away from a
// colleague is the claim, so that -- not this -- is where the override is
// made explicit and auditable.
function assertNotLockedByOther(order, terminal) {
  if (isLockedByOther(order, terminal)) {
    throw httpError(409,
      `Locked by ${order.locked_by_terminal_name || 'another terminal'} -- ask them to release it, or use a supervisor terminal.`,
      'ORDER_LOCKED');
  }
}

// Refreshes the idle countdown after a real action on the order, and adopts
// the lock for the caller when nobody live holds it. Call it from inside the
// same transaction as the mutation, AFTER assertNotLockedByOther -- so the
// row is already FOR UPDATE-locked and the caller is already known to be
// allowed to write.
//
// Two cases deliberately do nothing:
//   - someone else genuinely holds it: only reachable by a supervisor (the
//     bypass in isLockedByOther). Quietly stealing the lock there would evict
//     the colleague with no audit row; taking an order away from a live
//     holder stays an explicit, logged decision made at POST /claim.
//   - offline-queue replays landing long after the fact: harmless, they just
//     re-adopt a lock that had already gone stale, which is the same thing a
//     fresh claim would do.
async function touchLock(client, orderId, order, terminal) {
  if (isHeldByOther(order, terminal)) return;
  await client.query(
    `UPDATE pos_orders SET locked_by_terminal_id = $1, locked_by_terminal_name = $2,
            locked_by_device_id = $3, locked_at = NOW() WHERE id = $4`,
    [terminal.id, terminal.name, terminal.device_id, orderId]
  );
}

// Nothing proactively clears locked_by_terminal_id when a lock goes stale --
// isLockStale() is only ever consulted at claim/edit time, on whichever row
// a mutating route already has open. A terminal that abandons an order
// without hitting /release (closed the tab, app backgrounded, crashed) never
// triggers that check, so the raw column sits there stale indefinitely.
// Every READ path that hands locked_by_* to a client -- GET /orders (the
// Open Orders list badge) and fetchOrder() (single-order fetches, claim/
// mutation responses) -- must mask it through this first, or the UI shows
// "locked by X" forever after X's lock has already actually expired, even
// though a claim/edit attempt would correctly succeed. Masking only the
// response (not writing NULL back to the row) is deliberate: it's read-only,
// so it can never race a concurrent claim into clobbering a genuinely fresh
// lock underneath it.
// `terminal` is optional only so non-POS callers can reuse this; every POS
// route has req.terminal and should pass it, because locked_by_me is what the
// client uses to decide whether to show the 🔒 badge. The client cannot work
// that out on its own any more: the lock is identified by terminal_devices.id
// (see isLockMine), which is a server-side session id the browser never sees.
function maskStaleLock(order, terminal) {
  if (!order) return order;
  const held = order.locked_by_terminal_id != null || order.locked_by_device_id != null;
  if (held && isLockStale(order)) {
    return { ...order, locked_by_terminal_id: null, locked_by_terminal_name: null, locked_by_device_id: null, locked_at: null, locked_by_me: false };
  }
  return { ...order, locked_by_me: held && !!terminal && isLockMine(order, terminal) };
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

// Cached (like dining options above) — the global VAT on/off + rate changes
// rarely and is read on every order create. NOT used for in-progress orders
// (append/cancel-item) — those recompute from the order's own already-
// snapshotted vat_rate so an admin editing the rate mid-service never
// silently changes a ticket someone already started.
let vatSettingsCache = null; // { enabled, rate, expiresAt }

async function getVatSettings() {
  const now = Date.now();
  if (vatSettingsCache && vatSettingsCache.expiresAt > now) {
    return { enabled: vatSettingsCache.enabled, rate: vatSettingsCache.rate };
  }
  const { rows } = await pool.query('SELECT enabled, rate_percent FROM vat_settings ORDER BY id LIMIT 1');
  const enabled = !!(rows[0] && rows[0].enabled);
  const rate = rows[0] ? Number(rows[0].rate_percent) : 0;
  vatSettingsCache = { enabled, rate, expiresAt: now + CATALOG_TTL_MS };
  return { enabled, rate };
}

// subtotal/discount already net of each other; vatRate is a percent (e.g.
// 10) or null/0 when VAT is off. Rounds to whole KHR, same unit as every
// other money column here (NUMERIC(12,0)).
function calcVat(subtotal, discount, vatRate) {
  if (!vatRate) return 0;
  return Math.round(Math.max(0, subtotal - discount) * vatRate / 100);
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

// executor defaults to the pool (post-commit reads); pass the in-transaction
// `client` instead when building a response body that must be recorded in
// the idempotency ledger and committed atomically with it (see POST /orders
// and POST /orders/:id/items) -- pg's client and pool share the same
// .query() signature, so this is a drop-in either way.
async function fetchOrder(id, executor = pool, terminal = null) {
  const orderRes = await executor.query(`SELECT *, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1`, [id]);
  if (!orderRes.rows.length) return null;
  const itemsRes = await executor.query(
    `SELECT id, source_item_id, item_name, price, quantity, note, kitchen_status, version
     FROM pos_order_items WHERE order_id = $1 ORDER BY id`,
    [id]
  );
  return { ...maskStaleLock(orderRes.rows[0], terminal), items: itemsRes.rows };
}

// General POS-activity log, not cancellation-specific -- every event carries
// branch_id (denormalized, same pattern as pos_orders.branch_id) and
// detail.terminal_name for free, so a future event type needs no schema
// change, only a new `event` string and whatever `detail` shape it wants.
async function logOrderEvent(client, { orderId, branchId, event, terminal, created_at, detail }) {
  await client.query(
    `INSERT INTO pos_order_events (order_id, branch_id, event, actor, detail, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [orderId, branchId, event, terminal.terminal_id,
     JSON.stringify({ terminal_name: terminal.name, ...(detail || {}) }), created_at || toCambodiaTime(new Date())]
  );
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
    const vat = await getVatSettings();
    res.json({
      dining_options: diningRes.rows.map(r => r.dining_option),
      dine_in_option: DINE_IN_LABEL,
      payment_methods: PAYMENT_METHOD_OPTIONS,
      // So the client's idle countdown expires at the same moment the server
      // starts letting another terminal claim the order, instead of the two
      // drifting apart the first time this is retuned via env.
      order_lock_ttl_seconds: config.posOrderLockTtlSeconds,
      // Live preview only, for a cart that doesn't have a currentOrder yet --
      // once an order exists, its own vat_rate/vat_amount snapshot is what's
      // authoritative (see calcVat/getVatSettings comments above).
      vat_enabled: vat.enabled,
      vat_rate: vat.rate,
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

    const ordersRes = await pool.query(`SELECT *, ${LOCK_AGE_SQL} FROM pos_orders ${where} ORDER BY created_at DESC`, params);
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

    // server_now: a real UTC ISO timestamp, unlike created_at/sent_to_kitchen_at
    // which are naive Cambodia-local strings (see kds-elapsed-timezone.test.js
    // for why this pairing matters) -- lets the client compute "how long has
    // this order been sitting" without assuming its own clock/timezone
    // matches the server's.
    res.json({
      server_now: new Date().toISOString(),
      orders: ordersRes.rows.map(o => ({ ...maskStaleLock(o, req.terminal), items: itemsByOrder[o.id] || [] })),
    });
  } catch (err) {
    console.error('POS orders GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/:id', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });
  try {
    const order = await fetchOrder(id, pool, req.terminal);
    if (!order || order.branch_id !== req.terminal.branch_id) {
      return res.status(404).json({ message: 'Order not found.' });
    }
    res.json({ order });
  } catch (err) {
    console.error('POS get order error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/orders', requireTerminalAuth(['pos']), requireCsrf, async (req, res) => {
  const { dining_option, table_number, discount, items, client_mutation_id, client_time, provisional_number } = req.body;
  if (!dining_option) return res.status(400).json({ message: 'dining_option is required.' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'At least one item is required.' });
  }
  if (tooLong(table_number, 20)) return res.status(400).json({ message: 'table_number is too long (max 20 characters).' });
  if (discount !== undefined && !Number.isFinite(Number(discount))) {
    return res.status(400).json({ message: 'discount must be a number.' });
  }
  // Discounts are money -- there's no separate discount endpoint, this is
  // the only place one is ever set, so the gate lives here.
  if (Number(discount) > 0 && req.terminal.role !== 'supervisor') {
    return res.status(403).json({ message: 'Discounts require a supervisor terminal.' });
  }
  if (tooLong(provisional_number, 40)) return res.status(400).json({ message: 'provisional_number is too long.' });

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

    // A retried create (offline queue resending after the original response
    // was lost) replays the cached result instead of inserting a second
    // real order -- see services/pos/idempotency.js.
    const cached = await findIdempotentResponse(client, client_mutation_id);
    if (cached) {
      await client.query('COMMIT');
      return res.status(cached.statusCode).json(cached.body);
    }

    if (tableNum) await assertTableNumberAvailable(client, req.terminal.branch_id, tableNum, null);

    const lines = await snapshotItems(client, items);
    const subtotal   = lines.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const discountAmt = Math.max(0, Number(discount) || 0);
    const { enabled: vatEnabled, rate: vatRateLive } = await getVatSettings();
    const vatRate    = vatEnabled ? vatRateLive : null;
    const vatAmount  = calcVat(subtotal, discountAmt, vatRate);
    const total      = Math.max(0, subtotal - discountAmt) + vatAmount;

    const orderNumber = await generateOrderNumber(client);
    // Uses the device's own timestamp of when the order was actually taken
    // (bounds-checked) rather than the server's clock at whatever moment
    // this request happens to finally be processed -- otherwise an order
    // taken just before midnight but synced just after gets misattributed
    // to the wrong Cambodia business day. See services/pos/offlineClock.js.
    const actionTime = resolveActionTime(client_time);
    const now = toCambodiaTime(actionTime);
    // Order Name is always server-assigned at creation and never staff-
    // editable (POS revision, 2026-08-03) -- a manually-typed name invited
    // pre-order mislabeling (e.g. typed before the table/items were even
    // settled) and there is no rename endpoint left for staff to reach.
    const orderName = `Order ${formatCambodiaClockTime(actionTime)}`;

    // Saved as 'open' -- not yet visible to KDS. The client immediately
    // follows up with POST /orders/:id/send-to-kitchen; if that fails, the
    // order is still safely saved and can be retried or added to later.
    // The creating terminal implicitly holds the edit lock from the moment
    // the order exists -- no separate claim call needed for the terminal
    // that's already looking right at it (see POST /orders/:id/claim below).
    // locked_at is the DB's own clock (NOW()), not the naive Cambodia-local
    // business timestamp `now` -- it backs the idle TTL comparison
    // (posOrderLockTtlSeconds), which measures elapsed time and must never be
    // mixed with a business date. Its age is always computed back in SQL too
    // (LOCK_AGE_SQL); do not subtract it from Date.now() in JS -- the column
    // is timezone-naive and the two processes need not share a timezone.
    const orderRes = await client.query(`
      INSERT INTO pos_orders
        (order_number, status, dining_option, table_number, subtotal, discount, total, vat_rate, vat_amount, created_by, created_at, updated_at, terminal_id, branch_id, name, provisional_number, locked_by_terminal_id, locked_by_terminal_name, locked_by_device_id, locked_at)
      VALUES ($1,'open',$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$11,$15,$16,NOW())
      RETURNING *
    `, [orderNumber, dining_option, tableNum, subtotal, discountAmt, total, vatRate, vatAmount, req.terminal.terminal_id, now, req.terminal.id, req.terminal.branch_id, orderName, provisional_number || null, req.terminal.name, req.terminal.device_id]);

    const order = orderRes.rows[0];

    for (const line of lines) {
      await client.query(`
        INSERT INTO pos_order_items (order_id, source_item_id, item_name, price, quantity, note)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [order.id, line.source_item_id, line.name, line.price, line.quantity, line.note]);
    }

    await logOrderEvent(client, {
      orderId: order.id, branchId: order.branch_id, event: 'created', terminal: req.terminal, created_at: now,
      detail: { items: lines.map(l => ({ item_name: l.name, quantity: l.quantity })), item_count: lines.length, total },
    });

    const responseBody = { order: await fetchOrder(order.id, client, req.terminal) };
    await recordIdempotentResponse(client, client_mutation_id, 'create_order', order.id, 201, responseBody);

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.status(201).json(responseBody);
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS create order error:', err);
    res.status(status).json({ message: err.message, code: err.code });
  } finally {
    client.release();
  }
});

// Claim the order-edit lock (POS revision, 2026-08-03) -- called when a
// terminal opens an existing order into its panel, and again (throttled)
// whenever the cashier actually touches the cart, to renew locked_at. It is
// NOT called on a timer any more: an untouched order must be allowed to time
// out. Idempotent for the current holder (a renewal is just a re-claim), and
// succeeds outright once the previous holder's lock has gone stale -- see
// isLockedByOther() above.
//
// A supervisor terminal may still take an order away from a colleague who is
// actively holding it, but as of 2026-08-04 that is no longer SILENT: it
// requires an explicit `force: true` (the client asks the supervisor to
// confirm first, see loadOrderIntoPanel in pos.js) and writes a
// lock_overridden audit row naming both terminals. Before this, a GM/
// supervisor terminal opening a locked order just took it with a 200 and no
// indication to anyone -- which read as "the lock doesn't work at all".
//
// Deliberately NOT run through the offline-queue mutate() wrapper on the
// client: claiming a lock only means something while actually talking to
// the server, so a claim attempt made while offline degrades to best-effort
// local editing instead of being queued for later.
router.post('/orders/:id/claim', requireTerminalAuth(['pos']), requireCsrf, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query(`SELECT *, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!orderRes.rows.length || orderRes.rows[0].branch_id !== req.terminal.branch_id) {
      throw httpError(404, 'Order not found.');
    }
    const order = orderRes.rows[0];
    if (TERMINAL.has(order.status)) {
      throw httpError(409, `Cannot open a ${order.status} order.`, 'ORDER_TERMINAL');
    }
    assertNotLockedByOther(order, req.terminal);

    // Supervisor + someone else genuinely holding it + no explicit intent =
    // stop and ask, rather than silently seizing it. ORDER_LOCKED_OVERRIDABLE
    // (not plain ORDER_LOCKED) tells the client this one CAN be forced, so it
    // offers a confirm instead of a flat refusal.
    const takingOver = isHeldByOther(order, req.terminal);
    if (takingOver && !req.body.force) {
      throw httpError(409,
        `${order.locked_by_terminal_name || 'Another terminal'} has this order open. Take it over?`,
        'ORDER_LOCKED_OVERRIDABLE');
    }

    await client.query(
      `UPDATE pos_orders SET locked_by_terminal_id = $1, locked_by_terminal_name = $2, locked_by_device_id = $3, locked_at = NOW() WHERE id = $4`,
      [req.terminal.id, req.terminal.name, req.terminal.device_id, id]
    );
    if (takingOver) {
      await logOrderEvent(client, {
        orderId: id, branchId: order.branch_id, event: 'lock_overridden', terminal: req.terminal,
        detail: { taken_from_terminal_id: order.locked_by_terminal_id, taken_from_terminal_name: order.locked_by_terminal_name },
      });
    }
    const responseBody = { order: await fetchOrder(id, client, req.terminal), took_over: takingOver || undefined };
    await client.query('COMMIT');
    res.json(responseBody);
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS order claim error:', err);
    res.status(status).json({ message: err.message, code: err.code });
  } finally {
    client.release();
  }
});

// Explicit release, called when a terminal navigates away from the order it
// was holding (panel reset, order paid/cancelled, etc.) -- best-effort, not
// required for correctness: an abandoned lock is also cleared by the TTL in
// isLockStale() above the moment another terminal actually needs it. Only
// the current holder (or a supervisor) can release; anyone else's attempt is
// silently a no-op rather than an error, since by the time this fires the
// caller may no longer care about the outcome (e.g. sent via a "best effort,
// don't block navigation" fire-and-forget on the client).
router.post('/orders/:id/release', requireTerminalAuth(['pos']), requireCsrf, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });

  try {
    // Matched on the DEVICE that holds it (falling back to the terminal for
    // pre-migration-027 rows with a NULL device id) -- otherwise a second
    // window signed in under the same terminal code could release a lock it
    // does not hold, which is the same conflation migration 027 fixes.
    await pool.query(
      `UPDATE pos_orders SET locked_by_terminal_id = NULL, locked_by_terminal_name = NULL, locked_by_device_id = NULL, locked_at = NULL
       WHERE id = $1 AND branch_id = $2
         AND (locked_by_device_id = $3
              OR (locked_by_device_id IS NULL AND locked_by_terminal_id = $4)
              OR $5)`,
      [id, req.terminal.branch_id, req.terminal.device_id, req.terminal.id, req.terminal.role === 'supervisor']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POS order release error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Separated from creation so the client can auto-attempt this right after
// saving, but retry it independently (manually or via the offline queue) if
// just this step fails -- the order itself is never lost.
router.post('/orders/:id/send-to-kitchen', requireTerminalAuth(['pos']), requireCsrf, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query(`SELECT *, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!orderRes.rows.length) throw httpError(404, 'Order not found.');
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');
    assertNotLockedByOther(order, req.terminal);
    await touchLock(client, id, order, req.terminal);

    // Idempotent: a retried send against an order that's already past
    // 'open' (e.g. the previous attempt actually succeeded but its response
    // was lost) just returns the current order instead of erroring.
    if (order.status !== 'open') {
      if (order.status === 'cancelled') throw httpError(409, 'Cannot send a cancelled order to the kitchen.');
      await client.query('COMMIT');
      return res.json({ order: await fetchOrder(id, pool, req.terminal) });
    }

    const now = toCambodiaTime(resolveActionTime(req.body.client_time));
    await client.query(`UPDATE pos_orders SET status = 'sent_to_kitchen', sent_to_kitchen_at = $1, updated_at = $1 WHERE id = $2`, [now, id]);
    await logOrderEvent(client, { orderId: id, branchId: order.branch_id, event: 'sent_to_kitchen', terminal: req.terminal, created_at: now });

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(id, pool, req.terminal) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS send-to-kitchen error:', err);
    res.status(status).json({ message: err.message, code: err.code });
  } finally {
    client.release();
  }
});

// These single-field PATCH routes share the same shape: BEGIN + SELECT ...
// FOR UPDATE so the staleness check and the write are atomic against a
// concurrent PATCH/cancel/pay on the same order, instead of two separate
// bare pool.query() calls racing each other.
//
// (There used to be a PATCH /orders/:id/name here too -- removed 2026-08-03
// when Order Name became server-assigned-at-creation-only, see POST /orders.)
router.patch('/orders/:id/table-number', requireTerminalAuth(['pos']), requireCsrf, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });
  const { table_number, base_version } = req.body;
  if (tooLong(table_number, 20)) return res.status(400).json({ message: 'table_number is too long (max 20 characters).' });
  const tableNum = (table_number || '').trim() || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query(
      `SELECT status, branch_id, dining_option, version, locked_by_terminal_id, locked_by_terminal_name, locked_by_device_id, locked_at, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!orderRes.rows.length || orderRes.rows[0].branch_id !== req.terminal.branch_id) {
      throw httpError(404, 'Order not found.');
    }
    const order = orderRes.rows[0];
    if (TERMINAL.has(order.status)) {
      throw httpError(409, `Cannot change table number on a ${order.status} order.`, 'ORDER_TERMINAL');
    }
    assertNotLockedByOther(order, req.terminal);
    await touchLock(client, id, order, req.terminal);
    if (order.dining_option === DINE_IN_LABEL && !tableNum) {
      throw httpError(400, 'table_number is required for dine-in orders.');
    }
    const wasStale = isStaleVersion(base_version, order.version);
    if (tableNum) await assertTableNumberAvailable(client, req.terminal.branch_id, tableNum, id);

    await client.query(
      `UPDATE pos_orders SET table_number = $1, version = version + 1, updated_at = $2 WHERE id = $3`,
      [tableNum, toCambodiaTime(new Date()), id]
    );
    const responseBody = { order: await fetchOrder(id, client, req.terminal), ...(wasStale ? { notice: true, message: 'This order changed elsewhere -- your edit was applied on top of the latest version.' } : {}) };
    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json(responseBody);
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS table-number error:', err);
    res.status(status).json({ message: err.message, code: err.code });
  } finally {
    client.release();
  }
});

// Dining option is changeable any time the order isn't already finished --
// e.g. a cashier building a saved order can still switch dine-in/takeaway
// after items are already on it.
router.patch('/orders/:id/dining-option', requireTerminalAuth(['pos']), requireCsrf, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });
  const { dining_option, base_version } = req.body;
  if (!dining_option) return res.status(400).json({ message: 'dining_option is required.' });

  const validDining = await getValidDiningOptions();
  if (!validDining.has(dining_option)) {
    return res.status(400).json({ message: 'Unknown dining_option.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query(
      `SELECT status, branch_id, table_number, version, locked_by_terminal_id, locked_by_terminal_name, locked_by_device_id, locked_at, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!orderRes.rows.length || orderRes.rows[0].branch_id !== req.terminal.branch_id) {
      throw httpError(404, 'Order not found.');
    }
    const order = orderRes.rows[0];
    if (TERMINAL.has(order.status)) {
      throw httpError(409, `Cannot change dining option on a ${order.status} order.`, 'ORDER_TERMINAL');
    }
    assertNotLockedByOther(order, req.terminal);
    await touchLock(client, id, order, req.terminal);
    if (dining_option === DINE_IN_LABEL && !order.table_number) {
      throw httpError(400, 'Set a table number before switching this order to dine-in.');
    }
    const wasStale = isStaleVersion(base_version, order.version);

    await client.query(
      `UPDATE pos_orders SET dining_option = $1, version = version + 1, updated_at = $2 WHERE id = $3`,
      [dining_option, toCambodiaTime(new Date()), id]
    );
    const responseBody = { order: await fetchOrder(id, client, req.terminal), ...(wasStale ? { notice: true, message: 'This order changed elsewhere -- your edit was applied on top of the latest version.' } : {}) };
    await client.query('COMMIT');
    res.json(responseBody);
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS dining-option error:', err);
    res.status(status).json({ message: err.message, code: err.code });
  } finally {
    client.release();
  }
});

router.post('/orders/:id/items', requireTerminalAuth(['pos']), requireCsrf, async (req, res) => {
  const id = parseId(req.params.id);
  const { items, client_mutation_id, client_time } = req.body;
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'At least one item is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Same lost-response protection as create -- a retried append must not
    // double-add the same lines to a real order.
    const cached = await findIdempotentResponse(client, client_mutation_id);
    if (cached) {
      await client.query('COMMIT');
      return res.status(cached.statusCode).json(cached.body);
    }

    const orderRes = await client.query(`SELECT *, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!orderRes.rows.length) throw httpError(404, 'Order not found.');
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');
    if (TERMINAL.has(order.status)) throw httpError(409, `Cannot add items to a ${order.status} order.`, 'ORDER_TERMINAL');
    assertNotLockedByOther(order, req.terminal);
    await touchLock(client, id, order, req.terminal);

    const lines = await snapshotItems(client, items);
    for (const line of lines) {
      await client.query(`
        INSERT INTO pos_order_items (order_id, source_item_id, item_name, price, quantity, note)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [id, line.source_item_id, line.name, line.price, line.quantity, line.note]);
    }

    const addedSubtotal = lines.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const newSubtotal   = Number(order.subtotal) + addedSubtotal;
    const newDiscount   = Number(order.discount);
    // Recomputed from the order's OWN already-snapshotted vat_rate, never a
    // fresh getVatSettings() lookup -- an in-progress order must keep the
    // rate it was created with even if an admin edits the global rate
    // mid-service (same snapshot principle as pos_order_items.price).
    const newVatAmount  = calcVat(newSubtotal, newDiscount, order.vat_rate);
    const newTotal      = Math.max(0, newSubtotal - newDiscount) + newVatAmount;
    const now = toCambodiaTime(resolveActionTime(client_time));

    // New lines always start kitchen_status 'pending'. If the order had
    // already reached 'ready' or 'served', those brand-new pending items
    // would otherwise sit invisible to the kitchen: /kds/active renders a
    // 'ready' order as a pickup chip (no per-item list) and doesn't query
    // 'served' orders at all. Send it back through the kitchen exactly like
    // a fresh order -- refreshing sent_to_kitchen_at too, so the KDS elapsed
    // timer/warn-danger coloring reflects this new round of cooking rather
    // than however long the original items took.
    // 'awaiting_payment' included -- a last-minute added drink needs to be
    // made, so it pulls the order back into the kitchen exactly like a
    // ready/served order, which naturally drops it off the supervisor's
    // to-settle list until it's marked ready-to-bill again.
    const reactivating = order.status === 'ready' || order.status === 'served' || order.status === 'awaiting_payment';
    if (reactivating) {
      await client.query(
        `UPDATE pos_orders SET status = 'sent_to_kitchen', served_at = NULL, sent_to_kitchen_at = $1,
                subtotal = $2, total = $3, vat_amount = $4, version = version + 1, updated_at = $1 WHERE id = $5`,
        [now, newSubtotal, newTotal, newVatAmount, id]
      );
    } else {
      await client.query(
        `UPDATE pos_orders SET subtotal = $1, total = $2, vat_amount = $3, version = version + 1, updated_at = $4 WHERE id = $5`,
        [newSubtotal, newTotal, newVatAmount, now, id]
      );
    }
    // Logged unconditionally -- previously only logged when reactivating a
    // ready/served/awaiting_payment order (as 'items_added_after_ready'),
    // which meant a plain append to a still-open/in-kitchen order left no
    // audit trail at all. The dashboard Live Orders activity feed (routes/
    // receipts.js GET /own/live/activity) needs every append visible,
    // regardless of order status, to show things like "GM added 1 item to
    // Order X" in real time.
    await logOrderEvent(client, {
      orderId: id, branchId: order.branch_id, event: 'items_added', terminal: req.terminal, created_at: now,
      detail: { items: lines.map(l => ({ item_name: l.name, quantity: l.quantity })), reactivated: reactivating },
    });

    const responseBody = { order: await fetchOrder(id, client, req.terminal) };
    await recordIdempotentResponse(client, client_mutation_id, 'append_items', id, 200, responseBody);

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json(responseBody);
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS append items error:', err);
    res.status(status).json({ message: err.message, code: err.code });
  } finally {
    client.release();
  }
});

// Cancel Item -- replaces the old qty stepper (PATCH) and remove-line (DELETE)
// routes with one code path (POS revision, 2026-08-02). Deliberately no role
// gate and NO kitchen_status check of any kind: cancelling/reducing a line
// that's already 'preparing' or 'done' must always succeed -- that's the
// specific rule that silently didn't work before and is why this endpoint
// exists. qty omitted = remove the whole line; qty = how much to remove (not
// the resulting quantity).
router.post('/orders/:id/items/:itemId/cancel', requireTerminalAuth(['pos']), requireCsrf, async (req, res) => {
  const orderId = parseId(req.params.id);
  const itemId  = parseId(req.params.itemId);
  const { reason } = req.body;
  if (!orderId || !itemId) return res.status(400).json({ message: 'Invalid order or item id.' });
  if (tooLong(reason, 200)) return res.status(400).json({ message: 'reason is too long (max 200 characters).' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itemRes = await client.query('SELECT * FROM pos_order_items WHERE id = $1 AND order_id = $2 FOR UPDATE', [itemId, orderId]);
    if (!itemRes.rows.length) throw httpError(404, 'Order item not found.');
    const item = itemRes.rows[0];

    const orderRes = await client.query(`SELECT *, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');
    if (TERMINAL.has(order.status)) throw httpError(409, `Cannot edit items on a ${order.status} order.`, 'ORDER_TERMINAL');
    assertNotLockedByOther(order, req.terminal);
    await touchLock(client, orderId, order, req.terminal);

    const qtyToRemove = req.body.qty === undefined ? item.quantity : parseInt(req.body.qty, 10);
    if (!Number.isInteger(qtyToRemove) || qtyToRemove < 1 || qtyToRemove > item.quantity) {
      throw httpError(400, `qty must be a number between 1 and ${item.quantity}.`);
    }
    const remaining = item.quantity - qtyToRemove;

    if (remaining <= 0) {
      const countRes = await client.query('SELECT COUNT(*) AS n FROM pos_order_items WHERE order_id = $1', [orderId]);
      if (parseInt(countRes.rows[0].n, 10) <= 1) {
        throw httpError(409, 'Cannot remove the last item — cancel the order instead.');
      }
      await client.query('DELETE FROM pos_order_items WHERE id = $1', [itemId]);
    } else {
      await client.query('UPDATE pos_order_items SET quantity = $1, version = version + 1 WHERE id = $2', [remaining, itemId]);
    }

    const itemsRes  = await client.query('SELECT price, quantity FROM pos_order_items WHERE order_id = $1', [orderId]);
    const newSubtotal = itemsRes.rows.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
    const newDiscount = Number(order.discount);
    // Same snapshot rule as append-items: reuse order.vat_rate, never a live
    // getVatSettings() lookup.
    const newVatAmount = calcVat(newSubtotal, newDiscount, order.vat_rate);
    const newTotal     = Math.max(0, newSubtotal - newDiscount) + newVatAmount;
    const now = toCambodiaTime(resolveActionTime(req.body.client_time));
    await client.query(
      `UPDATE pos_orders SET subtotal = $1, total = $2, vat_amount = $3, version = version + 1, updated_at = $4 WHERE id = $5`,
      [newSubtotal, newTotal, newVatAmount, now, orderId]
    );

    // Carried over from the old DELETE route: if every remaining KDS-relevant
    // item is already done, auto-advance the order to 'ready' -- this REACTS
    // to kitchen_status, it never blocks on it.
    const allItemsRes = await client.query(`
      SELECT poi.kitchen_status
      FROM pos_order_items poi
      JOIN items i ON i.id = poi.source_item_id::uuid
      WHERE poi.order_id = $1
        AND EXISTS (
          SELECT 1 FROM kds_terminal_categories ktc
          WHERE ktc.category_id = COALESCE(i.custom_category_id, i.category_id)
        )
    `, [orderId]);
    const allDone = allItemsRes.rows.length > 0 && allItemsRes.rows.every(i => i.kitchen_status === 'done');
    if (allDone && order.status !== 'ready' && order.status !== 'served' && !TERMINAL.has(order.status)) {
      await client.query('UPDATE pos_orders SET status = $1, updated_at = $2 WHERE id = $3', ['ready', now, orderId]);
      await logOrderEvent(client, { orderId, branchId: order.branch_id, event: 'ready', terminal: req.terminal, created_at: now });
    }

    await logOrderEvent(client, {
      orderId, branchId: order.branch_id, event: 'item_cancelled', terminal: req.terminal, created_at: now,
      detail: {
        item_id: itemId, item_name: item.item_name,
        qty_removed: qtyToRemove, qty_remaining: Math.max(0, remaining),
        reason: reason || null,
      },
    });

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(orderId, pool, req.terminal) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS cancel item error:', err);
    res.status(status).json({ message: err.message, code: err.code });
  } finally {
    client.release();
  }
});

async function completeOrder(req, res) {
  const id = parseId(req.params.id);
  const { payment_method, cash_received, khqr_received, client_mutation_id } = req.body;
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });
  if (!['cash', 'khqr', 'both'].includes(payment_method)) {
    return res.status(400).json({ message: 'Unknown payment_method.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // A retried pay (offline queue resending after the original response
    // was lost) replays the cached receipt instead of hitting the
    // already-paid 409 -- canTransition() alone would make a retry safe
    // from a SECOND receipt either way, but without this it would land in
    // the dead-letter list as a false "rejection" even though the first
    // attempt actually succeeded.
    const cached = await findIdempotentResponse(client, client_mutation_id);
    if (cached) {
      await client.query('COMMIT');
      return res.status(cached.statusCode).json(cached.body);
    }

    const orderRes = await client.query(`SELECT *, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!orderRes.rows.length) throw httpError(404, 'Order not found.');
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');
    if (!canTransition(order.status, 'paid')) throw httpError(409, `Cannot pay a ${order.status} order.`, 'ORDER_TERMINAL');

    let cashReceivedVal = null;
    let khqrReceivedVal = null;
    if (payment_method === 'cash') {
      cashReceivedVal = Number(cash_received);
      if (!Number.isFinite(cashReceivedVal) || cashReceivedVal < Number(order.total)) {
        throw httpError(400, 'cash_received must be a number >= total.');
      }
    } else if (payment_method === 'both') {
      cashReceivedVal = Number(cash_received);
      khqrReceivedVal = Number(khqr_received);
      if (!Number.isFinite(cashReceivedVal) || !Number.isFinite(khqrReceivedVal) ||
          cashReceivedVal <= 0 || khqrReceivedVal <= 0) {
        throw httpError(400, 'cash_received and khqr_received must both be greater than 0 for a split payment.');
      }
      if (Math.round(cashReceivedVal + khqrReceivedVal) !== Math.round(Number(order.total))) {
        throw httpError(400, 'cash_received + khqr_received must equal the order total.');
      }
    }

    // Bounds-checked client action time -- see services/pos/offlineClock.js.
    // receipt_date drives every day-bucketed sales report, so this is the
    // single most important place this matters: a payment actually taken
    // at 23:55 must not land in the next day's report just because the sync
    // happened at 00:10.
    const now = toCambodiaTime(resolveActionTime(req.body.client_time));
    await client.query(`
      UPDATE pos_orders SET status = 'paid', payment_method = $1, cash_received = $2, paid_at = $3, updated_at = $3
      WHERE id = $4
    `, [payment_method, cashReceivedVal, now, id]);

    // Immutable financial record -- written once here, never updated again.
    // A refund later inserts its own new row (routes/receipts.js), it never
    // touches this one. provisional_number carries over from the order (set
    // if it was created offline) purely for staff traceability/reprint
    // matching against a paper ticket -- never used for anything financial.
    const receiptNumber = await generateReceiptNumber(client);
    const receiptRes = await client.query(`
      INSERT INTO pos_receipts
        (receipt_number, order_id, branch_id, pos_terminal_id, dining_option, subtotal, discount, total, vat_rate, vat_amount, receipt_date, created_by, provisional_number, completed_by_terminal_id, order_created_by_terminal_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id
    `, [receiptNumber, order.id, order.branch_id, req.terminal.id, order.dining_option,
        order.subtotal, order.discount, order.total, order.vat_rate, order.vat_amount, now, req.terminal.terminal_id, order.provisional_number,
        req.terminal.id, order.terminal_id]);
    const receiptId = receiptRes.rows[0].id;

    await client.query(`
      INSERT INTO pos_receipt_items (receipt_id, sku, item_name, quantity, price, gross_total)
      SELECT $1, it.sku, poi.item_name, poi.quantity, poi.price, poi.price * poi.quantity
      FROM pos_order_items poi
      LEFT JOIN items it ON it.id = poi.source_item_id::uuid
      WHERE poi.order_id = $2
    `, [receiptId, order.id]);

    if (payment_method === 'both') {
      const cashPm = PAYMENT_METHODS.cash;
      const khqrPm = PAYMENT_METHODS.khqr;
      await client.query(`
        INSERT INTO pos_receipt_payments (receipt_id, payment_name, payment_type, money_amount, paid_at)
        VALUES ($1,$2,$3,$4,$5)
      `, [receiptId, cashPm.payment_name, cashPm.payment_type, cashReceivedVal, now]);
      await client.query(`
        INSERT INTO pos_receipt_payments (receipt_id, payment_name, payment_type, money_amount, paid_at)
        VALUES ($1,$2,$3,$4,$5)
      `, [receiptId, khqrPm.payment_name, khqrPm.payment_type, khqrReceivedVal, now]);
    } else {
      const pm = PAYMENT_METHODS[payment_method];
      await client.query(`
        INSERT INTO pos_receipt_payments (receipt_id, payment_name, payment_type, money_amount, paid_at)
        VALUES ($1,$2,$3,$4,$5)
      `, [receiptId, pm.payment_name, pm.payment_type, order.total, now]);
    }

    await client.query(`UPDATE pos_orders SET receipt_id = $1 WHERE id = $2`, [receiptId, id]);

    await logOrderEvent(client, { orderId: id, branchId: order.branch_id, event: 'paid', terminal: req.terminal, created_at: now });

    const change = payment_method === 'cash' ? Number((cashReceivedVal - Number(order.total)).toFixed(0)) : 0;
    const responseBody = { order: await fetchOrder(id, client, req.terminal), receipt_number: receiptNumber, change };
    await recordIdempotentResponse(client, client_mutation_id, 'complete_order', id, 200, responseBody);

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json(responseBody);
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS complete order error:', err);
    res.status(status).json({ message: err.message, code: err.code });
  } finally {
    client.release();
  }
}

router.post('/orders/:id/pay',      requireTerminalAuth(['pos']), requireTerminalRole('supervisor'), requireCsrf, completeOrder);
router.post('/orders/:id/complete', requireTerminalAuth(['pos']), requireTerminalRole('supervisor'), requireCsrf, completeOrder);

// Any order terminal may push an order to awaiting_payment ("ready to bill")
// -- no role gate. Mirrors the cancel/served handlers below: FOR UPDATE
// fetch, branch check, canTransition guard, event row, broadcast.
router.post('/orders/:id/ready-to-bill', requireTerminalAuth(['pos']), requireCsrf, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cached = await findIdempotentResponse(client, req.body.client_mutation_id);
    if (cached) {
      await client.query('COMMIT');
      return res.status(cached.statusCode).json(cached.body);
    }

    const orderRes = await client.query(`SELECT *, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!orderRes.rows.length) throw httpError(404, 'Order not found.');
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');
    if (!canTransition(order.status, 'awaiting_payment')) throw httpError(409, `Cannot bill a ${order.status} order.`, 'ORDER_TERMINAL');
    assertNotLockedByOther(order, req.terminal);

    const now = toCambodiaTime(resolveActionTime(req.body.client_time));
    await client.query(
      `UPDATE pos_orders SET status = 'awaiting_payment', version = version + 1, updated_at = $1 WHERE id = $2`,
      [now, id]
    );
    await logOrderEvent(client, { orderId: id, branchId: order.branch_id, event: 'awaiting_payment', terminal: req.terminal, created_at: now });

    const responseBody = { order: await fetchOrder(id, client, req.terminal) };
    await recordIdempotentResponse(client, req.body.client_mutation_id, 'ready_to_bill', id, 200, responseBody);

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json(responseBody);
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS ready-to-bill error:', err);
    res.status(status).json({ message: err.message, code: err.code });
  } finally {
    client.release();
  }
});

// Any order or supervisor terminal in the branch may cancel any open order --
// no role gate, no kitchen_status check (POS revision, 2026-08-02). The
// accountability mechanism is the audit row below, not an access restriction.
router.post('/orders/:id/cancel', requireTerminalAuth(['pos']), requireCsrf, async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = req.body;
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });
  if (tooLong(reason, 200)) return res.status(400).json({ message: 'reason is too long (max 200 characters).' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query(`SELECT *, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!orderRes.rows.length) throw httpError(404, 'Order not found.');
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');
    if (!canTransition(order.status, 'cancelled')) throw httpError(409, `Cannot cancel a ${order.status} order.`, 'ORDER_TERMINAL');
    assertNotLockedByOther(order, req.terminal);

    const now = toCambodiaTime(resolveActionTime(req.body.client_time));
    await client.query(
      `UPDATE pos_orders SET status = 'cancelled', cancelled_at = $1, cancel_reason = $2, updated_at = $1 WHERE id = $3`,
      [now, reason || null, id]
    );
    await logOrderEvent(client, {
      orderId: id, branchId: order.branch_id, event: 'cancelled', terminal: req.terminal, created_at: now,
      detail: { order_total: order.total, reason: reason || null },
    });

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(id, pool, req.terminal) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS cancel error:', err);
    res.status(status).json({ message: err.message, code: err.code });
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

// Read-only lookback at recently cancelled orders for this station -- lets
// kitchen staff see why a card they were tracking disappeared from the
// active board, instead of it just vanishing with no trace. Same 24h
// rolling window / category filter / branch scope as /kds/finished.
router.get('/kds/cancelled', requireTerminalAuth(['kds']), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const categoryIds = await loadKdsCategoryIds(req.terminal.id);
    const settings = await loadKdsDisplaySettings();
    if (!categoryIds.length) {
      return res.json({ server_now: new Date().toISOString(), orders: [], no_categories_assigned: true, ...settings });
    }

    const ordersRes = await pool.query(
      `SELECT * FROM pos_orders
       WHERE status = 'cancelled' AND branch_id = $1
         AND cancelled_at >= (NOW() AT TIME ZONE 'Asia/Phnom_Penh') - INTERVAL '24 hours'
       ORDER BY cancelled_at DESC
       LIMIT 200`,
      [req.terminal.branch_id]
    );
    const orders = await attachFilteredItems(ordersRes.rows, categoryIds);
    res.json({ server_now: new Date().toISOString(), orders, ...settings });
  } catch (err) {
    console.error('POS kds cancelled GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/kds/stream', async (req, res) => {
  try {
    await verifySessionToken((req.cookies && req.cookies.cm_session) || '', ['kds']);
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

router.patch('/order-items/:id/kitchen-status', requireTerminalAuth(['kds']), requireCsrf, async (req, res) => {
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

    const orderRes = await client.query(`SELECT *, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1 FOR UPDATE`, [item.order_id]);
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
      await logOrderEvent(client, { orderId: order.id, branchId: order.branch_id, event: 'ready', terminal: req.terminal, created_at: now });
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

router.post('/orders/:id/ready', requireTerminalAuth(['kds']), requireCsrf, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query(`SELECT *, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1 FOR UPDATE`, [id]);
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
      await logOrderEvent(client, { orderId: id, branchId: order.branch_id, event: 'ready', terminal: req.terminal, created_at: now });
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
    res.status(status).json({ message: err.message, code: err.code });
  } finally {
    client.release();
  }
});

router.post('/orders/:id/served', requireTerminalAuth(['kds']), requireCsrf, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order id.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query(`SELECT *, ${LOCK_AGE_SQL} FROM pos_orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!orderRes.rows.length) throw httpError(404, 'Order not found.');
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order not found.');
    if (!canTransition(order.status, 'served')) throw httpError(409, `Cannot mark a ${order.status} order served.`);

    const now = toCambodiaTime(resolveActionTime(req.body.client_time));
    await client.query('UPDATE pos_orders SET status = $1, served_at = $2, updated_at = $2 WHERE id = $3', ['served', now, id]);
    await logOrderEvent(client, { orderId: id, branchId: order.branch_id, event: 'served', terminal: req.terminal, created_at: now });

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(id, pool, req.terminal) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS served error:', err);
    res.status(status).json({ message: err.message, code: err.code });
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
      SELECT r.id, r.receipt_number, r.dining_option, r.subtotal, r.discount, r.total, r.vat_rate, r.vat_amount,
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
    receipt.payments = payRes.rows;
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

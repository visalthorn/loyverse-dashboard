const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireWrite } = require('../middleware/auth');
const { toCambodiaTime } = require('../utils/date');

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

router.get('/', requireAuth, async (req, res) => {
  if (req.query.source === 'own') return getOwnReceipts(req, res);

  try {
    const page     = Math.max(1, parseInt(req.query.page) || 1);
    const per_page = Math.min(500, Math.max(1, parseInt(req.query.per_page) || 50));
    const offset   = (page - 1) * per_page;

    const filters = [];
    const params  = [];
    let i = 1;
    if (req.query.start) { filters.push(`DATE(r.receipt_date) >= $${i++}`); params.push(req.query.start); }
    if (req.query.end)   { filters.push(`DATE(r.receipt_date) <= $${i++}`); params.push(req.query.end); }
    if (req.query.type)  { filters.push(`UPPER(r.receipt_type) = UPPER($${i++})`); params.push(req.query.type); }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [totalRes, totalAmountRes, result] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM receipts r ${where}`, params),
      pool.query(`SELECT COALESCE(SUM(r.total_money),0) AS total_amount FROM receipts r ${where}`, params),
      pool.query(`
        SELECT r.id, r.receipt_number, r.order, r.receipt_date, r.receipt_type,
          CASE WHEN r.cancelled_at IS NULL THEN 'No' ELSE 'Yes' END AS is_canceled,
          r.total_money, pd.name AS pos_device,
          (SELECT jsonb_agg(jsonb_build_object('item_name',ri.item_name,'qty',ri.quantity,'unit_price',ri.price,'total_price',ri.gross_total))
           FROM receipt_items ri WHERE ri.receipt_number = r.receipt_number) AS items
        FROM receipts r LEFT JOIN pos_devices pd ON r.pos_device_id = CAST(pd.id AS varchar)
        ${where}
        ORDER BY r.receipt_date DESC, r.created_at DESC
        LIMIT $${i} OFFSET $${i + 1}
      `, [...params, per_page, offset]),
    ]);

    res.json({
      receipts:     result.rows,
      total:        parseInt(totalRes.rows[0].count || 0),
      total_amount: parseFloat(totalAmountRes.rows[0].total_amount || 0),
      page,
      per_page,
    });
  } catch (err) {
    console.error('Receipts GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Dashboard-only refund: marks the SAME pos_receipts row refunded
// (cancelled_at + cancel_reason) rather than inserting a second row --
// matches how the Loyverse-synced `receipts` table represents a refund
// (cancelled_at on the one row), instead of the "write once, insert a
// paired row" ledger this used to keep per migration 013. One row per
// order from here on: receipt_type (derived from cancelled_at, see
// getOwnReceipts below) just flips from SALE to REFUND in place.
router.post('/:id/refund', requireAuth, requireWrite('receipts'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid receipt id.' });
  const reason = (req.body.reason || '').slice(0, 200) || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const origRes = await client.query('SELECT id, cancelled_at FROM pos_receipts WHERE id = $1 FOR UPDATE', [id]);
    if (!origRes.rows.length) throw httpError(404, 'Receipt not found.');
    if (origRes.rows[0].cancelled_at) throw httpError(409, 'This receipt has already been refunded.');

    const now = toCambodiaTime(new Date());
    await client.query(
      `UPDATE pos_receipts SET cancelled_at = $1, cancel_reason = $2 WHERE id = $3`,
      [now, reason, id]
    );

    await client.query('COMMIT');
    res.json({ receipt_id: id });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS receipt refund error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
});

// Own in-house POS sales, normalized to the same shape as the Loyverse
// receipts above so the dashboard's receipts table/detail panel can render
// either source unmodified. Sourced from pos_receipts -- the immutable
// financial record written once at order completion (see migrations/013) --
// rather than the mutable pos_orders operational table.
async function getOwnReceipts(req, res) {
  try {
    const page     = Math.max(1, parseInt(req.query.page) || 1);
    const per_page = Math.min(500, Math.max(1, parseInt(req.query.per_page) || 50));
    const offset   = (page - 1) * per_page;

    const filters = [];
    const params  = [];
    let i = 1;
    if (req.query.start)  { filters.push(`DATE(r.receipt_date) >= $${i++}`); params.push(req.query.start); }
    if (req.query.end)    { filters.push(`DATE(r.receipt_date) <= $${i++}`); params.push(req.query.end); }
    if (req.query.branch) {
      const branchId = parseInt(req.query.branch, 10);
      if (Number.isInteger(branchId)) { filters.push(`r.branch_id = $${i++}`); params.push(branchId); }
    }
    if (req.query.type && req.query.type.toUpperCase() === 'REFUND') { filters.push(`r.cancelled_at IS NOT NULL`); }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [totalRes, totalAmountRes, result] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM pos_receipts r ${where}`, params),
      pool.query(`SELECT COALESCE(SUM(r.total),0) AS total_amount FROM pos_receipts r ${where}`, params),
      pool.query(`
        SELECT r.id, r.receipt_number, o.name AS order, r.receipt_date,
          CASE WHEN r.cancelled_at IS NULL THEN 'SALE' ELSE 'REFUND' END AS receipt_type,
          CASE WHEN r.cancelled_at IS NULL THEN 'No' ELSE 'Yes' END AS is_canceled,
          (r.cancelled_at IS NULL) AS refundable,
          r.total AS total_money, COALESCE(pt.name, pt.terminal_id, 'Dashboard') AS pos_device,
          (SELECT jsonb_agg(jsonb_build_object('item_name',ri.item_name,'qty',ri.quantity,'unit_price',ri.price,'total_price',ri.gross_total))
           FROM pos_receipt_items ri WHERE ri.receipt_id = r.id) AS items
        FROM pos_receipts r
        LEFT JOIN pos_orders o ON o.id = r.order_id
        LEFT JOIN pos_terminals pt ON pt.id = r.pos_terminal_id
        ${where}
        ORDER BY r.receipt_date DESC
        LIMIT $${i} OFFSET $${i + 1}
      `, [...params, per_page, offset]),
    ]);

    res.json({
      receipts:     result.rows,
      total:        parseInt(totalRes.rows[0].count || 0),
      total_amount: parseFloat(totalAmountRes.rows[0].total_amount || 0),
      page,
      per_page,
    });
  } catch (err) {
    console.error('Own receipts GET error:', err);
    res.status(500).json({ error: err.message });
  }
}

router.get('/own/live', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT po.id, po.order_number, po.name, po.status, po.dining_option, po.table_number,
             po.total, po.created_at, po.updated_at,
             b.name AS branch_name, COALESCE(pt.name, pt.terminal_id) AS terminal_name,
             (SELECT jsonb_agg(jsonb_build_object('item_name',poi.item_name,'qty',poi.quantity,'unit_price',poi.price,'total_price',poi.price * poi.quantity))
              FROM pos_order_items poi WHERE poi.order_id = po.id) AS items
      FROM pos_orders po
      LEFT JOIN branches b ON b.id = po.branch_id
      LEFT JOIN pos_terminals pt ON pt.id = po.terminal_id
      WHERE po.status NOT IN ('paid','cancelled')
      ORDER BY po.created_at ASC
    `);
    res.json({ orders: rows });
  } catch (err) {
    console.error('Own live orders GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Companion feed for the Live Orders card: a flat, most-recent-first log of
// every pos_order_events row (see routes/pos.js logOrderEvent) regardless of
// event type or the order's current status -- unlike GET /own/live above
// (a snapshot of currently-open orders), this is the actual action trail:
// "GM added 1 item to Order X", "POS-1 removed 1x Coke", etc., across every
// terminal, so a manager watching the dashboard sees every edit as it
// happens rather than just the order's latest totals. LIMIT 50 keeps this
// cheap enough for the same 5s poll as GET /own/live (see LIVE_ORDERS_POLL_MS
// in public/js/pages/receipts.js) -- a live feed has no use for full history,
// that's what GET /dashboard/cancellations (routes/cancellations.js) and its
// date-ranged query are for.
router.get('/own/live/activity', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.id, e.created_at, e.event, e.detail, e.order_id,
             e.detail->>'terminal_name' AS terminal_name,
             o.order_number, o.name AS order_name, o.branch_id, b.name AS branch_name
      FROM pos_order_events e
      JOIN pos_orders o ON o.id = e.order_id
      LEFT JOIN branches b ON b.id = o.branch_id
      ORDER BY e.created_at DESC
      LIMIT 50
    `);
    res.json({ events: rows });
  } catch (err) {
    console.error('Own live activity GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

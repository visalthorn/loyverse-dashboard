const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireWrite } = require('../middleware/auth');
const { toCambodiaTime } = require('../utils/date');
const { generateReceiptNumber } = require('../services/pos/receiptNumber');

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

router.get('/', requireAuth, async (req, res) => {
  if (req.query.source === 'own') return getOwnReceipts(req, res);

  try {
    const page     = Math.max(1, parseInt(req.query.page) || 1);
    const per_page = Math.min(500, Math.max(1, parseInt(req.query.per_page) || 25));
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

// Dashboard-only refund: never UPDATEs the original pos_receipts row --
// always INSERTs a brand-new row with cancelled_at set, copying items and
// payment from the original. Mirrors how a real refund works and matches
// the "written once, never updated" rule from migration 013.
router.post('/:id/refund', requireAuth, requireWrite('receipts'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid receipt id.' });
  const reason = (req.body.reason || '').slice(0, 200) || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const origRes = await client.query('SELECT * FROM pos_receipts WHERE id = $1 FOR UPDATE', [id]);
    if (!origRes.rows.length) throw httpError(404, 'Receipt not found.');
    const orig = origRes.rows[0];
    if (orig.cancelled_at) throw httpError(409, 'This receipt has already been refunded.');

    // The original row's cancelled_at is never set (migration 013 invariant),
    // so "already refunded" can't be read off `orig` itself -- it has to be
    // inferred from whether a refund row already exists for this order.
    // Lock the order first so two concurrent refund requests for the same
    // order_id serialize instead of racing past this check together.
    await client.query('SELECT id FROM pos_orders WHERE id = $1 FOR UPDATE', [orig.order_id]);
    const existingRefund = await client.query(
      'SELECT id FROM pos_receipts WHERE order_id = $1 AND cancelled_at IS NOT NULL LIMIT 1',
      [orig.order_id]
    );
    if (existingRefund.rows.length) throw httpError(409, 'This receipt has already been refunded.');

    const now = toCambodiaTime(new Date());
    const receiptNumber = await generateReceiptNumber(client);

    const copyRes = await client.query(`
      INSERT INTO pos_receipts
        (receipt_number, order_id, branch_id, pos_terminal_id, dining_option, subtotal, discount, total, receipt_date, cancelled_at, cancel_reason, created_by)
      VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$8,$9,$10)
      RETURNING id
    `, [receiptNumber, orig.order_id, orig.branch_id, orig.dining_option,
        orig.subtotal, orig.discount, orig.total, now, reason, req.user.username]);
    const refundId = copyRes.rows[0].id;

    await client.query(`
      INSERT INTO pos_receipt_items (receipt_id, sku, item_name, quantity, price, gross_total)
      SELECT $1, sku, item_name, quantity, price, gross_total FROM pos_receipt_items WHERE receipt_id = $2
    `, [refundId, id]);

    await client.query(`
      INSERT INTO pos_receipt_payments (receipt_id, payment_name, payment_type, money_amount, paid_at)
      SELECT $1, payment_name, payment_type, money_amount, $2 FROM pos_receipt_payments WHERE receipt_id = $3
    `, [refundId, now, id]);

    await client.query('COMMIT');
    res.status(201).json({ receipt_id: refundId, receipt_number: receiptNumber });
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
    const per_page = Math.min(500, Math.max(1, parseInt(req.query.per_page) || 25));
    const offset   = (page - 1) * per_page;

    const filters = [];
    const params  = [];
    let i = 1;
    if (req.query.start)  { filters.push(`DATE(r.receipt_date) >= $${i++}`); params.push(req.query.start); }
    if (req.query.end)    { filters.push(`DATE(r.receipt_date) <= $${i++}`); params.push(req.query.end); }
    if (req.query.branch) { filters.push(`r.branch_id = $${i++}`); params.push(parseInt(req.query.branch, 10)); }
    if (req.query.type && req.query.type.toUpperCase() === 'REFUND') { filters.push(`r.cancelled_at IS NOT NULL`); }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [totalRes, totalAmountRes, result] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM pos_receipts r ${where}`, params),
      pool.query(`SELECT COALESCE(SUM(r.total),0) AS total_amount FROM pos_receipts r ${where}`, params),
      pool.query(`
        SELECT r.id, r.receipt_number, o.name AS order, r.receipt_date,
          CASE WHEN r.cancelled_at IS NULL THEN 'SALE' ELSE 'REFUND' END AS receipt_type,
          CASE WHEN r.cancelled_at IS NULL THEN 'No' ELSE 'Yes' END AS is_canceled,
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

module.exports = router;

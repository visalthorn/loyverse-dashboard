const router = require('express').Router();
const pool   = require('../db');
const { requireAuth } = require('../middleware/auth');

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

// Own in-house POS sales, normalized to the same shape as the Loyverse
// receipts above so the dashboard's receipts table/detail panel can render
// either source unmodified. Only 'paid' orders count as a receipt -- a
// cancelled order was never actually sold.
async function getOwnReceipts(req, res) {
  try {
    const page     = Math.max(1, parseInt(req.query.page) || 1);
    const per_page = Math.min(500, Math.max(1, parseInt(req.query.per_page) || 25));
    const offset   = (page - 1) * per_page;

    const filters = [`po.status = 'paid'`];
    const params  = [];
    let i = 1;
    if (req.query.start) { filters.push(`DATE(po.paid_at) >= $${i++}`); params.push(req.query.start); }
    if (req.query.end)   { filters.push(`DATE(po.paid_at) <= $${i++}`); params.push(req.query.end); }
    // Own orders have no refund concept -- a REFUND filter matches nothing.
    if (req.query.type && req.query.type.toUpperCase() === 'REFUND') { filters.push('FALSE'); }

    const where = `WHERE ${filters.join(' AND ')}`;

    const [totalRes, totalAmountRes, result] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM pos_orders po ${where}`, params),
      pool.query(`SELECT COALESCE(SUM(po.total),0) AS total_amount FROM pos_orders po ${where}`, params),
      pool.query(`
        SELECT po.id, po.order_number AS receipt_number, po.name AS order,
          po.paid_at AS receipt_date, 'SALE' AS receipt_type, 'No' AS is_canceled,
          po.total AS total_money, COALESCE(pt.name, pt.terminal_id) AS pos_device,
          (SELECT jsonb_agg(jsonb_build_object('item_name',poi.item_name,'qty',poi.quantity,'unit_price',poi.price,'total_price',poi.price * poi.quantity))
           FROM pos_order_items poi WHERE poi.order_id = po.id) AS items
        FROM pos_orders po LEFT JOIN pos_terminals pt ON pt.id = po.terminal_id
        ${where}
        ORDER BY po.paid_at DESC
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

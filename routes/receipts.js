const router  = require('express').Router();
const dayjs   = require('dayjs');
const utc     = require('dayjs/plugin/utc');
const tzPlugin = require('dayjs/plugin/timezone');
const pool    = require('../db');
const { requireAuth, requireWrite } = require('../middleware/auth');
const { fetchReceipts } = require('../services/loyverse');
const { toCambodiaTime } = require('../utils/date');
const { tz } = require('../config');

dayjs.extend(utc);
dayjs.extend(tzPlugin);

router.get('/', requireAuth, async (req, res) => {
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

router.post('/sync', requireAuth, requireWrite('receipts'), async (req, res) => {
  try {
    const yesterday = dayjs().tz(tz).subtract(1, 'day');
    const start     = yesterday.startOf('day');
    const end       = yesterday.endOf('day');

    console.log(`📅 Checking receipts for ${yesterday.format('YYYY-MM-DD')}`);
    const exists = await pool.query(
      `SELECT 1 FROM receipts WHERE CAST(receipt_date AS date) = CAST($1 AS date) LIMIT 1`,
      [toCambodiaTime(yesterday.toISOString())]
    );

    console.log(`📊 Receipt exists for yesterday: ${exists.rowCount > 0 ? 'YES' : 'NO'}`);

    if (exists.rowCount <= 0) {
      console.log('🚀 Sync started');
      const receipts = await fetchReceipts(start, end);

      if (receipts.length > 0) {
        await pool.query('BEGIN');
        for (const r of receipts) {
          await pool.query(`
            INSERT INTO receipts
              (receipt_number,receipt_type,total_money,receipt_date,created_at,updated_at,cancelled_at,dining_option,source,store_id,pos_device_id,employee_id,"order")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            ON CONFLICT (receipt_number) DO NOTHING
          `, [
            r.receipt_number, r.receipt_type, r.total_money,
            toCambodiaTime(r.receipt_date), toCambodiaTime(r.created_at),
            toCambodiaTime(r.updated_at),   toCambodiaTime(r.cancelled_at),
            r.dining_option, r.source, r.store_id, r.pos_device_id, r.employee_id, r.order ?? null,
          ]);

          for (const item of r.line_items || []) {
            await pool.query(`
              INSERT INTO receipt_items (receipt_number,sku,item_name,quantity,price,gross_total)
              VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING
            `, [r.receipt_number, item.sku, item.item_name, item.quantity, item.price, item.gross_total_money]);
          }

          for (const payment of r.payments || []) {
            await pool.query(`
              INSERT INTO receipt_payments (receipt_number,payment_type_id,payment_name,payment_type,money_amount,paid_at)
              VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (receipt_number,payment_type_id) DO NOTHING
            `, [r.receipt_number, payment.payment_type_id, payment.name, payment.type, payment.money_amount, toCambodiaTime(payment.paid_at)]);
          }
        }
        await pool.query('COMMIT');
        console.log('✅ Sync complete');
      } else {
        console.log('⚠️ No data from Loyverse for yesterday');
      }
    } else {
      console.log('⏭ Skipping — receipt already exists for yesterday');
    }

    res.status(201).json({ message: 'Receipts synced successfully.' });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('❌ Sync failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

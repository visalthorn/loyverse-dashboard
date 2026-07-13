const pool = require('../../db');
const { writeSyncLog } = require('./log');

// Rebuild all six daily summary tables for [startDate, endDate] (inclusive,
// 'YYYY-MM-DD'). Idempotent: per-range delete + insert in one transaction.
// Each dimension table mirrors the WHERE clause of the analytics endpoint it
// replaces — see the spec's data-model section before changing any filter.
async function rebuildSummaries(startDate, endDate, triggeredBy = 'auto') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`DELETE FROM daily_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]);
    await client.query(`
      INSERT INTO daily_summary
        (day, sales_gross, sales_orders, refund_amount, refund_count,
         refund_open_amount, refund_open_count, cancelled_amount, cancelled_count)
      SELECT gs.day::date,
        COALESCE(SUM(r.total_money)   FILTER (WHERE r.receipt_type='SALE'   AND r.cancelled_at IS NULL), 0),
        COUNT(r.receipt_number)       FILTER (WHERE r.receipt_type='SALE'   AND r.cancelled_at IS NULL),
        COALESCE(SUM(r.total_money)   FILTER (WHERE r.receipt_type='REFUND' AND r.cancelled_at IS NOT NULL), 0),
        COUNT(r.receipt_number)       FILTER (WHERE r.receipt_type='REFUND' AND r.cancelled_at IS NOT NULL),
        COALESCE(SUM(r.total_money)   FILTER (WHERE r.receipt_type='REFUND' AND r.cancelled_at IS NULL), 0),
        COUNT(r.receipt_number)       FILTER (WHERE r.receipt_type='REFUND' AND r.cancelled_at IS NULL),
        COALESCE(SUM(r.total_money)   FILTER (WHERE r.receipt_type='SALE'   AND r.cancelled_at IS NOT NULL), 0),
        COUNT(r.receipt_number)       FILTER (WHERE r.receipt_type='SALE'   AND r.cancelled_at IS NOT NULL)
      FROM generate_series($1::date, $2::date, '1 day'::interval) AS gs(day)
      LEFT JOIN receipts r ON DATE(r.receipt_date) = gs.day::date
      GROUP BY gs.day::date
    `, [startDate, endDate]);

    await client.query(`DELETE FROM daily_dining_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]);
    await client.query(`
      INSERT INTO daily_dining_summary (day, dining_option, orders, revenue)
      SELECT DATE(receipt_date), COALESCE(dining_option, 'Unknown'), COUNT(*), COALESCE(SUM(total_money), 0)
      FROM receipts
      WHERE DATE(receipt_date) BETWEEN $1 AND $2 AND cancelled_at IS NULL
      GROUP BY 1, 2
    `, [startDate, endDate]);

    await client.query(`DELETE FROM daily_payment_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]);
    await client.query(`
      INSERT INTO daily_payment_summary (day, payment_name, payment_type, transactions, total)
      SELECT DATE(r.receipt_date), rp.payment_name, COALESCE(rp.payment_type, ''), COUNT(*), COALESCE(SUM(rp.money_amount), 0)
      FROM receipt_payments rp
      JOIN receipts r ON r.receipt_number = rp.receipt_number
      WHERE DATE(r.receipt_date) BETWEEN $1 AND $2 AND r.cancelled_at IS NULL AND r.receipt_type = 'SALE'
      GROUP BY 1, 2, 3
    `, [startDate, endDate]);

    await client.query(`DELETE FROM daily_item_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]);
    await client.query(`
      INSERT INTO daily_item_summary (day, sku, item_name, qty, revenue)
      SELECT DATE(r.receipt_date), COALESCE(ri.sku, ''), MAX(ri.item_name), SUM(ri.quantity), COALESCE(SUM(ri.gross_total), 0)
      FROM receipt_items ri
      JOIN receipts r ON r.receipt_number = ri.receipt_number
      WHERE DATE(r.receipt_date) BETWEEN $1 AND $2 AND r.receipt_type = 'SALE' AND r.cancelled_at IS NULL
      GROUP BY 1, 2
    `, [startDate, endDate]);

    await client.query(`DELETE FROM daily_hour_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]);
    await client.query(`
      INSERT INTO daily_hour_summary (day, hour, orders, revenue)
      SELECT DATE(receipt_date), EXTRACT(HOUR FROM receipt_date)::smallint, COUNT(*), COALESCE(SUM(total_money), 0)
      FROM receipts
      WHERE DATE(receipt_date) BETWEEN $1 AND $2 AND cancelled_at IS NULL
      GROUP BY 1, 2
    `, [startDate, endDate]);

    await client.query(`DELETE FROM daily_device_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]);
    await client.query(`
      INSERT INTO daily_device_summary (day, pos_device_id, device_name, orders, revenue)
      SELECT DATE(r.receipt_date), COALESCE(r.pos_device_id, ''), COALESCE(pd.name, r.pos_device_id),
             COUNT(*) FILTER (WHERE r.cancelled_at IS NULL),
             COALESCE(SUM(r.total_money) FILTER (WHERE r.cancelled_at IS NULL), 0)
      FROM receipts r
      LEFT JOIN pos_devices pd ON pd.id::varchar = r.pos_device_id
      WHERE DATE(r.receipt_date) BETWEEN $1 AND $2
      GROUP BY 1, 2, 3
    `, [startDate, endDate]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await writeSyncLog({ syncType: 'summaries', syncDate: endDate, status: 'failed', triggeredBy, inserted: 0, error: err.message });
    throw err;
  } finally {
    client.release();
  }

  const days = (await pool.query(
    `SELECT COUNT(*) AS n FROM daily_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]
  )).rows[0].n;
  await writeSyncLog({ syncType: 'summaries', syncDate: endDate, status: 'success', triggeredBy, inserted: parseInt(days) });
  return { status: 'success', days: parseInt(days) };
}

module.exports = { rebuildSummaries };

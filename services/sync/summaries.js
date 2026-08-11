const pool = require('../../db');
const { writeSyncLog } = require('./log');
const { netMoneyExpr, netExpr, notCancelledClause } = require('../../utils/money');

// Rebuild all six daily summary tables for [startDate, endDate] (inclusive,
// 'YYYY-MM-DD'). Idempotent: per-range delete + insert in one transaction.
// Each dimension table mirrors the WHERE clause of the analytics endpoint it
// replaces — see the spec's data-model section before changing any filter.
async function rebuildSummaries(startDate, endDate, triggeredBy = 'auto') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // All six tables now read through v_receipts_all/v_receipt_items_all/
    // v_receipt_payments_all (migrations/010_merge_views.sql) instead of the
    // raw Loyverse-only receipts/receipt_items/receipt_payments tables, so
    // Summary Report includes in-house POS-terminal sales alongside Loyverse
    // -- same views routes/analytics.js has read through since Phase 7.
    // Column meanings (see utils/money.js for the full rule):
    //   sales_gross         SALE, not cancelled -- gross_income = sales_gross - refund_amount, NEVER + refund_*
    //   refund_amount       REFUND, not cancelled -- a genuine, still-valid refund (money actually left)
    //   refund_open_amount  REFUND, cancelled -- a refund that was itself voided/reversed (money never left);
    //                       kept as its own bucket for visibility, must never be added to gross_income
    //   cancelled_amount    ANY receipt type with cancelled_at set -- Loyverse Cancel excludes it from sales
    //                       reports regardless of type, so this isn't SALE-only
    await client.query(`DELETE FROM daily_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]);
    await client.query(`
      INSERT INTO daily_summary
        (day, sales_gross, sales_orders, refund_amount, refund_count,
         refund_open_amount, refund_open_count, cancelled_amount, cancelled_count)
      SELECT gs.day::date,
        COALESCE(SUM(r.total_money)   FILTER (WHERE r.receipt_type='SALE'   AND r.cancelled_at IS NULL), 0),
        COUNT(r.receipt_number)       FILTER (WHERE r.receipt_type='SALE'   AND r.cancelled_at IS NULL),
        COALESCE(SUM(r.total_money)   FILTER (WHERE r.receipt_type='REFUND' AND r.cancelled_at IS NULL), 0),
        COUNT(r.receipt_number)       FILTER (WHERE r.receipt_type='REFUND' AND r.cancelled_at IS NULL),
        COALESCE(SUM(r.total_money)   FILTER (WHERE r.receipt_type='REFUND' AND r.cancelled_at IS NOT NULL), 0),
        COUNT(r.receipt_number)       FILTER (WHERE r.receipt_type='REFUND' AND r.cancelled_at IS NOT NULL),
        COALESCE(SUM(r.total_money)   FILTER (WHERE r.cancelled_at IS NOT NULL), 0),
        COUNT(r.receipt_number)       FILTER (WHERE r.cancelled_at IS NOT NULL)
      FROM generate_series($1::date, $2::date, '1 day'::interval) AS gs(day)
      LEFT JOIN v_receipts_all r ON DATE(r.receipt_date) = gs.day::date
      GROUP BY gs.day::date
    `, [startDate, endDate]);

    await client.query(`DELETE FROM daily_dining_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]);
    await client.query(`
      INSERT INTO daily_dining_summary (day, dining_option, orders, revenue)
      SELECT DATE(receipt_date), COALESCE(dining_option, 'Unknown'),
             COUNT(*) FILTER (WHERE receipt_type = 'SALE'), COALESCE(SUM(${netMoneyExpr()}), 0)
      FROM v_receipts_all
      WHERE DATE(receipt_date) BETWEEN $1 AND $2 AND ${notCancelledClause()}
      GROUP BY 1, 2
    `, [startDate, endDate]);

    await client.query(`DELETE FROM daily_payment_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]);
    await client.query(`
      INSERT INTO daily_payment_summary (day, payment_name, payment_type, transactions, total)
      SELECT DATE(r.receipt_date), rp.payment_name, COALESCE(rp.payment_type, ''),
             COUNT(*) FILTER (WHERE r.receipt_type = 'SALE'), COALESCE(SUM(${netExpr('rp.money_amount', 'r')}), 0)
      FROM v_receipt_payments_all rp
      JOIN v_receipts_all r ON r.receipt_number = rp.receipt_number
      WHERE DATE(r.receipt_date) BETWEEN $1 AND $2 AND ${notCancelledClause('r')}
      GROUP BY 1, 2, 3
    `, [startDate, endDate]);

    await client.query(`DELETE FROM daily_item_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]);
    await client.query(`
      INSERT INTO daily_item_summary (day, sku, item_name, qty, revenue)
      SELECT DATE(r.receipt_date), COALESCE(ri.sku, ''), MAX(ri.item_name),
             SUM(${netExpr('ri.quantity', 'r')}), COALESCE(SUM(${netExpr('ri.gross_total', 'r')}), 0)
      FROM v_receipt_items_all ri
      JOIN v_receipts_all r ON r.receipt_number = ri.receipt_number
      WHERE DATE(r.receipt_date) BETWEEN $1 AND $2 AND ${notCancelledClause('r')}
      GROUP BY 1, 2
    `, [startDate, endDate]);

    await client.query(`DELETE FROM daily_hour_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]);
    await client.query(`
      INSERT INTO daily_hour_summary (day, hour, orders, revenue)
      SELECT DATE(receipt_date), EXTRACT(HOUR FROM receipt_date)::smallint,
             COUNT(*) FILTER (WHERE receipt_type = 'SALE'), COALESCE(SUM(${netMoneyExpr()}), 0)
      FROM v_receipts_all
      WHERE DATE(receipt_date) BETWEEN $1 AND $2 AND ${notCancelledClause()}
      GROUP BY 1, 2
    `, [startDate, endDate]);

    // device_name: own-POS rows carry no pos_device_id (that table is
    // Loyverse-hardware-only) -- labelled "Own POS" instead of a blank
    // string, same convention routes/analytics.js's device-performance
    // endpoint already uses for the live (non-summary) view.
    await client.query(`DELETE FROM daily_device_summary WHERE day BETWEEN $1 AND $2`, [startDate, endDate]);
    await client.query(`
      INSERT INTO daily_device_summary (day, pos_device_id, device_name, orders, revenue)
      SELECT DATE(r.receipt_date), COALESCE(r.pos_device_id, ''),
             COALESCE(pd.name, CASE WHEN r.source = 'OWN_POS' THEN 'Own POS' ELSE r.pos_device_id END),
             COUNT(*) FILTER (WHERE r.receipt_type = 'SALE'), COALESCE(SUM(${netExpr('r.total_money', 'r')}), 0)
      FROM v_receipts_all r
      LEFT JOIN pos_devices pd ON pd.id::varchar = r.pos_device_id
      WHERE DATE(r.receipt_date) BETWEEN $1 AND $2 AND ${notCancelledClause('r')}
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

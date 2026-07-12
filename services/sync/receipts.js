const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
const pool   = require('../../db');
const { fetchReceipts } = require('../loyverse');
const { toCambodiaTime } = require('../../utils/date');
const { tz } = require('../../config');
const { writeSyncLog } = require('./log');

dayjs.extend(utc);
dayjs.extend(tzPlug);

async function syncYesterdayReceipts(triggeredBy = 'auto') {
  const yesterday = dayjs().tz(tz).subtract(1, 'day');
  const syncDate  = yesterday.format('YYYY-MM-DD');
  const start     = yesterday.startOf('day');
  const end       = yesterday.endOf('day');

  console.log(`📅 [sync] Checking receipts for ${syncDate} (triggered_by: ${triggeredBy})`);

  const exists = await pool.query(
    `SELECT 1 FROM receipts WHERE CAST(receipt_date AS date) = CAST($1 AS date) LIMIT 1`,
    [toCambodiaTime(yesterday.toISOString())]
  );

  if (exists.rowCount > 0) {
    console.log(`⏭  [sync] Skipping — receipt already exists for ${syncDate}`);
    await writeSyncLog({ syncType: 'receipts', syncDate, status: 'skipped', triggeredBy, inserted: 0 });
    return { status: 'skipped', inserted: 0 };
  }

  let receipts;
  try {
    receipts = await fetchReceipts(start, end);
  } catch (err) {
    console.error(`❌ [sync] Loyverse fetch failed:`, err.message);
    await writeSyncLog({ syncType: 'receipts', syncDate, status: 'failed', triggeredBy, inserted: 0, error: err.message });
    return { status: 'failed', inserted: 0, error: err.message };
  }

  if (receipts.length === 0) {
    console.log(`⚠️  [sync] No receipts from Loyverse for ${syncDate}`);
    await writeSyncLog({ syncType: 'receipts', syncDate, status: 'skipped', triggeredBy, inserted: 0 });
    return { status: 'skipped', inserted: 0 };
  }

  try {
    await pool.query('BEGIN');
    let inserted = 0;

    for (const r of receipts) {
      const res = await pool.query(`
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
      if (res.rowCount > 0) inserted++;

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
    console.log(`✅ [sync] Complete — ${inserted} receipts inserted for ${syncDate}`);
    await writeSyncLog({ syncType: 'receipts', syncDate, status: 'success', triggeredBy, inserted });
    return { status: 'success', inserted };
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(`❌ [sync] DB insert failed:`, err.message);
    await writeSyncLog({ syncType: 'receipts', syncDate, status: 'failed', triggeredBy, inserted: 0, error: err.message });
    return { status: 'failed', inserted: 0, error: err.message };
  }
}

module.exports = { syncYesterdayReceipts };

const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
const pool   = require('../../db');
const { fetchReceipts } = require('../loyverse');
const { toCambodiaTime } = require('../../utils/date');
const { tz } = require('../../config');
const { writeSyncLog } = require('./log');
const { startSyncRun, finishSyncRun } = require('./runs');
const { rebuildSummaries } = require('./summaries');

dayjs.extend(utc);
dayjs.extend(tzPlug);

const MAX_RANGE_DAYS = 90;

function rangeError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// sync_logs.triggered_by is read with exact-match checks elsewhere (scheduler
// status card, GET /api/sync/status) that only know 'auto' | 'catchup' |
// 'manual' -- so a real username (now recorded on sync_runs for a proper
// audit trail) still collapses to 'manual' here to keep that display logic
// working unchanged.
function legacyTriggeredBy(triggeredBy) {
  return triggeredBy === 'auto' || triggeredBy === 'catchup' ? triggeredBy : 'manual';
}

// Upserts one Loyverse receipt plus its line items and payments. Child rows
// are deleted and reinserted rather than ON CONFLICT DO NOTHING -- receipt_items
// has no unique constraint to conflict on (Loyverse doesn't expose a stable
// per-line id), and this also picks up edits Loyverse made to an existing
// receipt after its first sync. Must run inside the caller's transaction.
async function upsertReceipt(client, r) {
  // DO UPDATE SET is deliberately narrow -- only fields Loyverse can change
  // after a receipt is first created (cancelled_at, total_money, receipt_type,
  // updated_at, dining_option). Everything else (receipt_date, source,
  // store_id, pos_device_id, employee_id, order, refund_for, created_at) is
  // identity/context set once at insert and never touched again, and
  // created_db_at is never in this column list at all.
  const res = await client.query(`
    INSERT INTO receipts
      (receipt_number,receipt_type,total_money,receipt_date,created_at,updated_at,cancelled_at,dining_option,source,store_id,pos_device_id,employee_id,"order",refund_for)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (receipt_number) DO UPDATE SET
      cancelled_at=$7, total_money=$3, receipt_type=$2, updated_at=$6, dining_option=$8
    RETURNING (xmax = 0) AS was_insert
  `, [
    r.receipt_number, r.receipt_type, r.total_money,
    toCambodiaTime(r.receipt_date), toCambodiaTime(r.created_at),
    toCambodiaTime(r.updated_at),   toCambodiaTime(r.cancelled_at),
    r.dining_option, r.source, r.store_id, r.pos_device_id, r.employee_id, r.order ?? null,
    r.refund_for ?? null,
  ]);
  const wasInsert = res.rows[0].was_insert;

  await client.query('DELETE FROM receipt_items WHERE receipt_number = $1', [r.receipt_number]);
  for (const item of r.line_items || []) {
    await client.query(`
      INSERT INTO receipt_items (receipt_number,sku,item_name,quantity,price,gross_total)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [r.receipt_number, item.sku, item.item_name, item.quantity, item.price, item.gross_total_money]);
  }

  await client.query('DELETE FROM receipt_payments WHERE receipt_number = $1', [r.receipt_number]);
  for (const payment of r.payments || []) {
    await client.query(`
      INSERT INTO receipt_payments (receipt_number,payment_type_id,payment_name,payment_type,money_amount,paid_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (receipt_number,payment_type_id) DO NOTHING
    `, [r.receipt_number, payment.payment_type_id, payment.name, payment.type, payment.money_amount, toCambodiaTime(payment.paid_at)]);
  }

  return wasInsert;
}

// Syncs a single Cambodia calendar date. Replaces the old "skip if any
// receipt exists" guard with a completeness check: fetch Loyverse's count
// for the date and compare with what we have stored.
//   - Equal            -> already complete, mark success, no writes.
//   - Loyverse > ours   -> genuine gap (e.g. a prior run only saw a partial
//                          page before Loyverse's cursor went stale) -> upsert.
//   - Loyverse < ours   -> Loyverse reports fewer than we already have. Most
//                          likely the free-tier ~30-day receipt retention
//                          window has passed for this date, or a receipt was
//                          deleted upstream -- either way Loyverse can no
//                          longer prove what we have wrong, so local data is
//                          trusted as-is rather than treated as a gap.
async function syncReceiptsForDate(dateStr, triggeredBy = 'auto') {
  const dayStart = dayjs.tz(dateStr, tz).startOf('day');
  const dayEnd   = dayjs.tz(dateStr, tz).endOf('day');

  const runId = await startSyncRun(dateStr, triggeredBy);
  console.log(`📅 [sync] Checking receipts for ${dateStr} (triggered_by: ${triggeredBy})`);

  let receipts;
  try {
    receipts = await fetchReceipts(dayStart, dayEnd);
  } catch (err) {
    console.error(`❌ [sync] Loyverse fetch failed for ${dateStr}:`, err.message);
    await finishSyncRun(runId, { status: 'failed', errorMessage: err.message });
    await writeSyncLog({ syncType: 'receipts', syncDate: dateStr, status: 'failed', triggeredBy: legacyTriggeredBy(triggeredBy), inserted: 0, error: err.message });
    return { status: 'failed', inserted: 0, updated: 0, error: err.message };
  }

  const loyverseCount = receipts.length;
  const ourCountBefore = parseInt(
    (await pool.query('SELECT COUNT(*) FROM receipts WHERE CAST(receipt_date AS date) = $1::date', [dateStr])).rows[0].count,
    10
  );

  if (loyverseCount === ourCountBefore) {
    console.log(`✅ [sync] ${dateStr} already complete — ${ourCountBefore} receipts, nothing to do`);
    await finishSyncRun(runId, { status: 'success', receiptsFetched: loyverseCount, receiptsInserted: 0, receiptsUpdated: 0, loyverseReportedCount: loyverseCount });
    await writeSyncLog({ syncType: 'receipts', syncDate: dateStr, status: 'success', triggeredBy: legacyTriggeredBy(triggeredBy), inserted: 0 });
    return { status: 'success', inserted: 0, updated: 0, fetched: loyverseCount };
  }

  if (loyverseCount < ourCountBefore) {
    const note = `Loyverse reports ${loyverseCount} receipts, fewer than the ${ourCountBefore} already stored (likely past Loyverse's receipt retention window, or a receipt was removed upstream). Local data kept as-is.`;
    console.log(`ℹ️  [sync] ${dateStr}: ${note}`);
    await finishSyncRun(runId, { status: 'success', receiptsFetched: loyverseCount, receiptsInserted: 0, receiptsUpdated: 0, loyverseReportedCount: loyverseCount, errorMessage: note });
    await writeSyncLog({ syncType: 'receipts', syncDate: dateStr, status: 'success', triggeredBy: legacyTriggeredBy(triggeredBy), inserted: 0 });
    return { status: 'success', inserted: 0, updated: 0, fetched: loyverseCount, note };
  }

  // loyverseCount > ourCountBefore -- a real gap. Re-upsert the whole day;
  // ON CONFLICT covers receipts already present so this always converges.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0, updated = 0;
    for (const r of receipts) {
      const wasInsert = await upsertReceipt(client, r);
      if (wasInsert) inserted++; else updated++;
    }
    await client.query('COMMIT');

    const ourCountAfter = parseInt(
      (await pool.query('SELECT COUNT(*) FROM receipts WHERE CAST(receipt_date AS date) = $1::date', [dateStr])).rows[0].count,
      10
    );
    const status = ourCountAfter === loyverseCount ? 'success' : 'partial';
    console.log(`${status === 'success' ? '✅' : '⚠️ '} [sync] ${dateStr} — ${inserted} inserted, ${updated} updated (${ourCountAfter}/${loyverseCount})`);

    await finishSyncRun(runId, { status, receiptsFetched: loyverseCount, receiptsInserted: inserted, receiptsUpdated: updated, loyverseReportedCount: loyverseCount });
    await writeSyncLog({ syncType: 'receipts', syncDate: dateStr, status, triggeredBy: legacyTriggeredBy(triggeredBy), inserted });

    try {
      await rebuildSummaries(dateStr, dateStr, legacyTriggeredBy(triggeredBy));
    } catch (err) {
      console.error('❌ [sync] Summary rebuild failed:', err.message);
    }

    return { status, inserted, updated, fetched: loyverseCount };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`❌ [sync] DB upsert failed for ${dateStr}:`, err.message);
    await finishSyncRun(runId, { status: 'failed', receiptsFetched: loyverseCount, errorMessage: err.message });
    await writeSyncLog({ syncType: 'receipts', syncDate: dateStr, status: 'failed', triggeredBy: legacyTriggeredBy(triggeredBy), inserted: 0, error: err.message });
    return { status: 'failed', inserted: 0, updated: 0, error: err.message };
  } finally {
    client.release();
  }
}

async function syncYesterdayReceipts(triggeredBy = 'auto') {
  const yesterday = dayjs().tz(tz).subtract(1, 'day').format('YYYY-MM-DD');
  return syncReceiptsForDate(yesterday, triggeredBy);
}

// Iterates a date range day by day so each date is tracked independently --
// one failure mid-range doesn't roll back days already fixed. Capped at
// MAX_RANGE_DAYS so a typo in start_date can't trigger a huge Loyverse pull.
async function syncReceiptsRange(startDateStr, endDateStr, triggeredBy = 'manual') {
  const start = dayjs.tz(startDateStr, tz).startOf('day');
  const end   = dayjs.tz(endDateStr, tz).startOf('day');

  if (!start.isValid() || !end.isValid())
    throw rangeError('start_date and end_date must be valid dates (YYYY-MM-DD).');
  if (end.isBefore(start))
    throw rangeError('end_date must be on or after start_date.');

  const spanDays = end.diff(start, 'day') + 1;
  if (spanDays > MAX_RANGE_DAYS)
    throw rangeError(`Range too large (${spanDays} days) — max ${MAX_RANGE_DAYS} days per call.`);

  const results = [];
  let cur = start;
  while (!cur.isAfter(end)) {
    const dateStr = cur.format('YYYY-MM-DD');
    const result = await syncReceiptsForDate(dateStr, triggeredBy);
    results.push({ date: dateStr, ...result });
    cur = cur.add(1, 'day');
  }
  return results;
}

module.exports = { syncReceiptsForDate, syncYesterdayReceipts, syncReceiptsRange, MAX_RANGE_DAYS, upsertReceipt };

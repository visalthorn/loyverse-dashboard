const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
const pool   = require('../../db');
const loyverse = require('../loyverse');
const { toCambodiaTime } = require('../../utils/date');
const { tz } = require('../../config');
const { writeSyncLog } = require('./log');
const { rebuildSummaries } = require('./summaries');
const { MAX_RANGE_DAYS } = require('./receipts');

dayjs.extend(utc);
dayjs.extend(tzPlug);

function rangeError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Branches with a backup Loyverse account configured (branch_loyverse_backup
// is populated by hand via SQL, no admin UI -- see migrations/040). The
// default branch never has a row here, so it never shows up as a target.
async function listBackupBranches() {
  const r = await pool.query(`
    SELECT b.id, b.name
    FROM branches b
    JOIN branch_loyverse_backup l ON l.branch_id = b.id
    ORDER BY b.name
  `);
  return r.rows;
}

async function getBackupAccount(branchId) {
  const r = await pool.query(
    'SELECT branch_id, store_id, token FROM branch_loyverse_backup WHERE branch_id = $1',
    [branchId]
  );
  if (!r.rowCount) throw rangeError('No backup Loyverse account configured for this branch.');
  return r.rows[0];
}

// Structurally impossible to collide with a primary-account or in-house-POS
// receipt_number (neither ever starts with a letter) -- see plan doc /
// CLAUDE.md for why receipt_number alone isn't safe across Loyverse accounts.
function tag(branchId, receiptNumber) {
  return receiptNumber == null ? null : `BKB${branchId}-${receiptNumber}`;
}

// Mirrors services/sync/receipts.js#upsertReceipt's column list and
// ON CONFLICT shape, but with the tagged receipt_number/refund_for and
// source forced to 'loyverse_backup'. Must run inside the caller's transaction.
async function upsertBackupReceipt(client, branchId, r) {
  const receiptNumber = tag(branchId, r.receipt_number);
  const refundFor      = tag(branchId, r.refund_for);

  const res = await client.query(`
    INSERT INTO receipts
      (receipt_number,receipt_type,total_money,receipt_date,created_at,updated_at,cancelled_at,dining_option,source,store_id,pos_device_id,employee_id,"order",refund_for)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'loyverse_backup',$9,$10,$11,$12,$13)
    ON CONFLICT (receipt_number) DO UPDATE SET
      cancelled_at=$7, total_money=$3, receipt_type=$2, updated_at=$6, dining_option=$8
    RETURNING (xmax = 0) AS was_insert
  `, [
    receiptNumber, r.receipt_type, r.total_money,
    toCambodiaTime(r.receipt_date), toCambodiaTime(r.created_at),
    toCambodiaTime(r.updated_at),   toCambodiaTime(r.cancelled_at),
    r.dining_option, r.store_id, r.pos_device_id, r.employee_id, r.order ?? null,
    refundFor,
  ]);
  const wasInsert = res.rows[0].was_insert;

  await client.query('DELETE FROM receipt_items WHERE receipt_number = $1', [receiptNumber]);
  for (const item of r.line_items || []) {
    await client.query(`
      INSERT INTO receipt_items (receipt_number,sku,item_name,quantity,price,gross_total)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [receiptNumber, item.sku, item.item_name, item.quantity, item.price, item.gross_total_money]);
  }

  await client.query('DELETE FROM receipt_payments WHERE receipt_number = $1', [receiptNumber]);
  for (const payment of r.payments || []) {
    await client.query(`
      INSERT INTO receipt_payments (receipt_number,payment_type_id,payment_name,payment_type,money_amount,paid_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (receipt_number,payment_type_id) DO NOTHING
    `, [receiptNumber, payment.payment_type_id, payment.name, payment.type, payment.money_amount, toCambodiaTime(payment.paid_at)]);
  }

  return wasInsert;
}

// Auto-provisions pos_devices rows for this backup account's device IDs,
// pointing branch_id at the branch this sync targets. Unlike the primary
// pos-devices sync (upsertPosDevices), which deliberately never writes
// branch_id, this is the whole point here -- the store_id -> branch mapping
// the user set up in branch_loyverse_backup IS the assignment. COALESCE
// guards against clobbering a branch_id an admin later set by hand.
async function ensureDevicesMapped(client, branchId, receipts) {
  const deviceIds = [...new Set(receipts.map(r => r.pos_device_id).filter(Boolean))];
  for (const deviceId of deviceIds) {
    const device = receipts.find(r => r.pos_device_id === deviceId);
    await client.query(`
      INSERT INTO pos_devices (id, store_id, branch_id, activated, synced_at)
      VALUES ($1, $2, $3, true, NOW())
      ON CONFLICT (id) DO UPDATE
        SET branch_id = COALESCE(pos_devices.branch_id, EXCLUDED.branch_id), synced_at = NOW()
    `, [deviceId, device?.store_id || null, branchId]);
  }
}

// Same completeness-check shape as services/sync/receipts.js#syncReceiptsForDate,
// scoped to this branch's tagged rows so it never interacts with the primary
// account's own completeness check.
async function syncBackupReceiptsForDate(branchId, dateStr, triggeredBy = 'manual') {
  const account = await getBackupAccount(branchId);
  const dayStart = dayjs.tz(dateStr, tz).startOf('day');
  const dayEnd   = dayjs.tz(dateStr, tz).endOf('day');

  console.log(`📅 [backup-sync] branch ${branchId}: checking receipts for ${dateStr}`);

  let receipts;
  try {
    const client = loyverse.createClient(account.token);
    receipts = await loyverse.fetchReceiptsWithClient(client, dayStart, dayEnd);
  } catch (err) {
    console.error(`❌ [backup-sync] Loyverse fetch failed for ${dateStr}:`, err.message);
    await writeSyncLog({ syncType: 'backup_receipts', syncDate: dateStr, status: 'failed', triggeredBy, inserted: 0, error: err.message });
    return { status: 'failed', inserted: 0, updated: 0, error: err.message };
  }

  const loyverseCount = receipts.length;
  const likePattern = `BKB${branchId}-%`;
  const ourCountBefore = parseInt(
    (await pool.query(
      "SELECT COUNT(*) FROM receipts WHERE CAST(receipt_date AS date) = $1::date AND source = 'loyverse_backup' AND receipt_number LIKE $2",
      [dateStr, likePattern]
    )).rows[0].count,
    10
  );

  if (loyverseCount === ourCountBefore) {
    console.log(`✅ [backup-sync] ${dateStr} already complete — ${ourCountBefore} receipts, nothing to do`);
    await writeSyncLog({ syncType: 'backup_receipts', syncDate: dateStr, status: 'success', triggeredBy, inserted: 0 });
    return { status: 'success', inserted: 0, updated: 0, fetched: loyverseCount };
  }

  if (loyverseCount < ourCountBefore) {
    const note = `Loyverse reports ${loyverseCount} receipts, fewer than the ${ourCountBefore} already stored. Local data kept as-is.`;
    console.log(`ℹ️  [backup-sync] ${dateStr}: ${note}`);
    await writeSyncLog({ syncType: 'backup_receipts', syncDate: dateStr, status: 'success', triggeredBy, inserted: 0 });
    return { status: 'success', inserted: 0, updated: 0, fetched: loyverseCount, note };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureDevicesMapped(client, branchId, receipts);
    let inserted = 0, updated = 0;
    for (const r of receipts) {
      const wasInsert = await upsertBackupReceipt(client, branchId, r);
      if (wasInsert) inserted++; else updated++;
    }
    await client.query('COMMIT');

    const ourCountAfter = parseInt(
      (await pool.query(
        "SELECT COUNT(*) FROM receipts WHERE CAST(receipt_date AS date) = $1::date AND source = 'loyverse_backup' AND receipt_number LIKE $2",
        [dateStr, likePattern]
      )).rows[0].count,
      10
    );
    const status = ourCountAfter === loyverseCount ? 'success' : 'partial';
    console.log(`${status === 'success' ? '✅' : '⚠️ '} [backup-sync] ${dateStr} — ${inserted} inserted, ${updated} updated (${ourCountAfter}/${loyverseCount})`);

    await writeSyncLog({ syncType: 'backup_receipts', syncDate: dateStr, status, triggeredBy, inserted });

    try {
      await rebuildSummaries(dateStr, dateStr, triggeredBy);
    } catch (err) {
      console.error('❌ [backup-sync] Summary rebuild failed:', err.message);
    }

    return { status, inserted, updated, fetched: loyverseCount, stored: ourCountAfter };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`❌ [backup-sync] DB upsert failed for ${dateStr}:`, err.message);
    await writeSyncLog({ syncType: 'backup_receipts', syncDate: dateStr, status: 'failed', triggeredBy, inserted: 0, error: err.message });
    return { status: 'failed', inserted: 0, updated: 0, error: err.message };
  } finally {
    client.release();
  }
}

function syncYesterdayBackupReceipts(branchId, triggeredBy = 'manual') {
  const yesterday = dayjs().tz(tz).subtract(1, 'day').format('YYYY-MM-DD');
  return syncBackupReceiptsForDate(branchId, yesterday, triggeredBy);
}

async function syncBackupReceiptsRange(branchId, startDateStr, endDateStr, triggeredBy = 'manual') {
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
    const result = await syncBackupReceiptsForDate(branchId, dateStr, triggeredBy);
    results.push({ date: dateStr, ...result });
    cur = cur.add(1, 'day');
  }
  return results;
}

module.exports = { listBackupBranches, syncBackupReceiptsForDate, syncYesterdayBackupReceipts, syncBackupReceiptsRange };

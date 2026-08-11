// One-off repair for historical rows where a receipt's mutable Loyverse
// fields (cancelled_at, total_money, receipt_type, dining_option,
// updated_at) changed AFTER our first sync -- e.g. a sale that was
// cancelled, or refunded, later. The regular day-to-day sync
// (services/sync/receipts.js:syncReceiptsForDate) only re-fetches a date
// when Loyverse's receipt COUNT for that date differs from ours; a receipt
// whose fields mutated without the day's total count changing would never
// get picked up by that path. This script re-fetches every receipt in a
// date range and force-compares each one's mutable fields against Loyverse,
// regardless of count.
//
// Usage:
//   node scripts/resync-mutable.js <start_date> <end_date>          dry run (default) -- prints what would change, writes nothing
//   node scripts/resync-mutable.js <start_date> <end_date> --apply  actually applies the changes
//
// Dates are Cambodia calendar dates, YYYY-MM-DD, inclusive, capped at
// MAX_RANGE_DAYS (see services/sync/receipts.js) same as the range sync API.

const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tzPlug);

const pool   = require('../db');
const { fetchReceipts } = require('../services/loyverse');
const { toCambodiaTime } = require('../utils/date');
const { tz } = require('../config');
const { upsertReceipt, MAX_RANGE_DAYS } = require('../services/sync/receipts');
const { rebuildSummaries } = require('../services/sync/summaries');

const MUTABLE_FIELDS = ['cancelled_at', 'total_money', 'receipt_type', 'dining_option', 'updated_at'];

function normalize(field, value) {
  if (value === null || value === undefined) return null;
  if (field === 'cancelled_at' || field === 'updated_at') return toCambodiaTime(value);
  if (field === 'total_money') return Number(value);
  return String(value);
}

// Compares Loyverse's current value for each mutable field against what we
// have stored, both normalized the same way. Returns the list of fields
// that differ (empty = no drift).
function diffFields(stored, fresh) {
  const changed = [];
  for (const field of MUTABLE_FIELDS) {
    const a = normalize(field, stored[field]);
    const b = normalize(field, field === 'cancelled_at' ? fresh.cancelled_at
                              : field === 'updated_at'   ? fresh.updated_at
                              : field === 'total_money'  ? fresh.total_money
                              : field === 'receipt_type' ? fresh.receipt_type
                              : fresh.dining_option);
    if (a !== b) changed.push({ field, was: a, now: b });
  }
  return changed;
}

async function planDate(dateStr) {
  const dayStart = dayjs.tz(dateStr, tz).startOf('day');
  const dayEnd   = dayjs.tz(dateStr, tz).endOf('day');
  const receipts = await fetchReceipts(dayStart, dayEnd);

  const receiptNumbers = receipts.map(r => r.receipt_number);
  const stored = receiptNumbers.length
    ? (await pool.query(
        `SELECT receipt_number, cancelled_at, total_money, receipt_type, dining_option, updated_at
         FROM receipts WHERE receipt_number = ANY($1::varchar[])`,
        [receiptNumbers]
      )).rows
    : [];
  const storedByNumber = Object.fromEntries(stored.map(r => [r.receipt_number, r]));

  const toInsert = [];
  const toUpdate = [];
  for (const r of receipts) {
    const existing = storedByNumber[r.receipt_number];
    if (!existing) { toInsert.push(r); continue; }
    const changed = diffFields(existing, r);
    if (changed.length) toUpdate.push({ receipt: r, changed });
  }
  return { date: dateStr, fetched: receipts.length, toInsert, toUpdate };
}

async function main() {
  const [, , startArg, endArg, ...rest] = process.argv;
  const apply = rest.includes('--apply');

  if (!startArg || !endArg) {
    console.error('Usage: node scripts/resync-mutable.js <start_date> <end_date> [--apply]');
    process.exit(1);
  }

  const start = dayjs.tz(startArg, tz).startOf('day');
  const end   = dayjs.tz(endArg, tz).startOf('day');
  if (!start.isValid() || !end.isValid() || end.isBefore(start)) {
    console.error('start_date and end_date must be valid YYYY-MM-DD dates, with end >= start.');
    process.exit(1);
  }
  const spanDays = end.diff(start, 'day') + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    console.error(`Range too large (${spanDays} days) — max ${MAX_RANGE_DAYS} days per run.`);
    process.exit(1);
  }

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — scanning ${startArg}..${endArg} (${spanDays} day(s)) for mutable-field drift\n`);

  const plans = [];
  let cur = start;
  while (!cur.isAfter(end)) {
    const dateStr = cur.format('YYYY-MM-DD');
    const plan = await planDate(dateStr);
    plans.push(plan);
    if (plan.toInsert.length || plan.toUpdate.length) {
      console.log(`${dateStr}: ${plan.fetched} fetched, ${plan.toInsert.length} missing, ${plan.toUpdate.length} changed`);
      for (const { receipt, changed } of plan.toUpdate) {
        const desc = changed.map(c => `${c.field}: ${JSON.stringify(c.was)} -> ${JSON.stringify(c.now)}`).join(', ');
        console.log(`    ${receipt.receipt_number}: ${desc}`);
      }
    }
    cur = cur.add(1, 'day');
  }

  const totalInsert = plans.reduce((s, p) => s + p.toInsert.length, 0);
  const totalUpdate = plans.reduce((s, p) => s + p.toUpdate.length, 0);

  console.log(`\n${totalInsert} row(s) missing entirely, ${totalUpdate} row(s) with drifted fields, across ${plans.length} day(s).`);

  if (!apply) {
    console.log('\nDry run only -- nothing was written. Re-run with --apply to write these changes.');
    await pool.end();
    return;
  }

  if (totalInsert === 0 && totalUpdate === 0) {
    console.log('\nNothing to apply.');
    await pool.end();
    return;
  }

  console.log('\nApplying...');
  const client = await pool.connect();
  let inserted = 0, updated = 0;
  try {
    await client.query('BEGIN');
    for (const plan of plans) {
      for (const r of plan.toInsert) {
        const wasInsert = await upsertReceipt(client, r);
        if (wasInsert) inserted++; else updated++;
      }
      for (const { receipt } of plan.toUpdate) {
        const wasInsert = await upsertReceipt(client, receipt);
        if (wasInsert) inserted++; else updated++;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Repair failed, rolled back:', err.message);
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  console.log(`Applied — ${inserted} inserted, ${updated} updated.`);

  console.log('Rebuilding summaries for the affected range...');
  await rebuildSummaries(startArg, endArg, 'manual');
  console.log('Done.');

  await pool.end();
}

main().catch(e => { console.error('ERR', e); process.exit(1); });

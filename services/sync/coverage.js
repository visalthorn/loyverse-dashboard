const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
const pool   = require('../../db');
const { tz } = require('../../config');
const { latestRunsInRange } = require('./runs');

dayjs.extend(utc);
dayjs.extend(tzPlug);

// Per-day coverage for the last `numDays` Cambodia calendar dates (ending
// yesterday -- today is still accumulating in Loyverse, so it isn't a
// meaningful "gap" yet). Backed by sync_runs where available; dates synced
// before that table existed fall back to "has any receipts" as a coarser
// signal so old history doesn't show up as a wall of false gaps.
//
// Shared by GET /api/sync/receipts/coverage (routes/sync.js), the weekly
// gap-heal cron and GET /api/health (services/sync/scheduler.js), so all
// three agree on what counts as a "gap".
async function getReceiptsCoverage(numDays) {
  const end   = dayjs().tz(tz).subtract(1, 'day');
  const start = end.subtract(numDays - 1, 'day');
  const startStr = start.format('YYYY-MM-DD');
  const endStr   = end.format('YYYY-MM-DD');

  const [countsRes, runs] = await Promise.all([
    pool.query(`
      SELECT CAST(receipt_date AS date)::text AS d, COUNT(*)::int AS cnt
      FROM receipts
      WHERE CAST(receipt_date AS date) BETWEEN $1::date AND $2::date
      GROUP BY 1
    `, [startStr, endStr]),
    latestRunsInRange(startStr, endStr),
  ]);

  const countByDate = {};
  countsRes.rows.forEach(r => { countByDate[r.d] = r.cnt; });
  const runByDate = {};
  runs.forEach(r => { runByDate[r.sync_date] = r; });

  const days = [];
  let cur = start;
  while (!cur.isAfter(end)) {
    const dateStr = cur.format('YYYY-MM-DD');
    const count = countByDate[dateStr] || 0;
    const run = runByDate[dateStr];

    let status, lastSyncAt;
    if (run) {
      status = run.status;
      lastSyncAt = run.finished_at || run.started_at;
    } else {
      status = count > 0 ? 'success' : 'missing';
      lastSyncAt = null;
    }
    const gap = status === 'failed' || status === 'partial' || status === 'missing';

    days.push({
      date: dateStr, count, status, gap, lastSyncAt,
      loyverseReportedCount: run?.loyverse_reported_count ?? null,
      errorMessage: run?.error_message ?? null,
    });
    cur = cur.add(1, 'day');
  }

  return { start: startStr, end: endStr, days };
}

module.exports = { getReceiptsCoverage };

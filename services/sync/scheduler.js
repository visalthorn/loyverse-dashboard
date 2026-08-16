const cron   = require('node-cron');
const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
const pool   = require('../../db');
const { tz, env } = require('../../config');
const { syncYesterdayReceipts, syncReceiptsForDate } = require('./receipts');
const { syncItems } = require('./items');
const { getReceiptsCoverage } = require('./coverage');
const { alertSyncFailure, alertSyncPartial, sendHealthSummaryIfNeeded } = require('./alerts');

dayjs.extend(utc);
dayjs.extend(tzPlug);

// In-memory scheduler health, exposed via GET /api/sync/status.
const status = {
  serverStartedAt: new Date().toISOString(),
  schedulerActive: false,
  lastCronFireAt:  null,
};

// Next 00:05 in Cambodia time as an ISO timestamp -- the main daily sync;
// what the scheduler status card counts down to. Business expects gross
// income for "yesterday" ready shortly after midnight, hence 00:05 rather
// than a later hour.
function nextRunAt() {
  const now = dayjs().tz(tz);
  let next = now.hour(0).minute(5).second(0).millisecond(0);
  if (!next.isAfter(now)) next = next.add(1, 'day');
  return next.toISOString();
}

// Advisory-lock keys -- arbitrary distinct bigints, one per scheduled job.
// Session-scoped (tied to the connection that acquired it): if the holding
// process crashes or the connection drops, Postgres releases the lock
// automatically, so a dead run can never wedge a job permanently the way a
// stale 'running' row + manual timeout would. Guards against two app
// instances (e.g. a Railway deploy overlap) firing the same job at once.
const LOCK_DAILY_SYNC   = 8821001;
const LOCK_WEEKLY_HEAL  = 8821002;
const LOCK_HEALTH_ALERT = 8821003;
const LOCK_ITEMS_SYNC   = 8821004;

async function withAdvisoryLock(key, label, fn) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    if (!rows[0].locked) {
      console.log(`⏭  [cron] ${label} — lock held elsewhere, another instance is already running this, skipping`);
      return;
    }
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
}

// Runs one date's sync and fires the matching Telegram alert on failure or
// partial completion. Shared by the daily job, the weekly heal, and the
// boot-time catchup so all three "shout" the same way.
async function syncDateAndAlert(dateStr, triggeredBy) {
  const result = await syncReceiptsForDate(dateStr, triggeredBy);
  if (result.status === 'failed') {
    await alertSyncFailure({ date: dateStr, error: result.error, triggeredBy });
  } else if (result.status === 'partial') {
    await alertSyncPartial({ date: dateStr, expected: result.fetched, stored: result.stored, triggeredBy });
  }
  return result;
}

async function runDailySync() {
  const yesterday = dayjs().tz(tz).subtract(1, 'day').format('YYYY-MM-DD');
  return syncDateAndAlert(yesterday, 'scheduler');
}

// Catalog (items + categories) sync, still at 08:45 -- now runs AFTER the
// 00:05 receipts sync rather than before it (receipts sync moved back to
// 00:05 to match the business's midnight gross-income expectation; items
// sync was left in place). Failure here is logged (via syncItems' own
// writeSyncLog call) but doesn't raise a Telegram alert the way receipts
// sync failures do -- a stale catalog for one day is a minor inconvenience,
// not a data-completeness problem the way a missed receipts sync is.
async function runItemsSync() {
  const result = await syncItems('scheduler');
  if (result.status === 'failed') {
    console.error(`❌ [cron] Scheduled items sync failed: ${result.error}`);
  } else {
    console.log(`✅ [cron] Scheduled items sync — ${result.status} (${result.inserted} upserted)`);
  }
  return result;
}

// Scans the last 14 days for gaps (missing/partial/failed) and re-syncs
// only those dates -- self-heals a day that was missed or came back
// partial without anyone having to notice and click Backfill.
async function runWeeklyHeal() {
  const coverage = await getReceiptsCoverage(14);
  const gapDates = coverage.days.filter(d => d.gap).map(d => d.date);
  console.log(`🩹 [cron] Weekly gap-heal — ${gapDates.length} gap day(s) found in the last 14 days`);

  const results = [];
  for (const dateStr of gapDates) {
    results.push({ date: dateStr, ...(await syncDateAndAlert(dateStr, 'scheduler')) });
  }
  return { checked: coverage.days.length, gaps: gapDates.length, results };
}

// If the app was down over the 00:05 tick, the run is lost -- heal it on
// boot. Checks via the (cheap, DB-only) coverage helper first so a clean
// restart with nothing missing doesn't cost a Loyverse API call or add
// sync_runs noise.
async function runCatchupIfNeeded() {
  const yesterday = dayjs().tz(tz).subtract(1, 'day').format('YYYY-MM-DD');
  const coverage = await getReceiptsCoverage(1);
  const day = coverage.days[0];
  if (day && !day.gap) {
    console.log('⏭  [cron] Catch-up not needed — yesterday already synced');
    return { ran: false };
  }
  console.log('🩹 [cron] Missed run detected — running catch-up sync');
  const result = await syncDateAndAlert(yesterday, 'catchup');
  return { ran: true, result };
}

function startScheduler() {
  cron.schedule('45 8 * * *', () => {
    console.log('⏰ [cron] Firing daily items/categories sync (08:45)');
    withAdvisoryLock(LOCK_ITEMS_SYNC, 'items sync', runItemsSync)
      .catch(err => console.error('❌ [cron] Items sync failed:', err.message));
  }, { scheduled: true, timezone: tz });

  cron.schedule('5 0 * * *', () => {
    status.lastCronFireAt = new Date().toISOString();
    console.log('⏰ [cron] Firing daily receipts sync (00:05)');
    withAdvisoryLock(LOCK_DAILY_SYNC, 'daily sync', runDailySync)
      .catch(err => console.error('❌ [cron] Daily sync failed:', err.message));
  }, { scheduled: true, timezone: tz });

  cron.schedule('30 9 * * 1', () => {
    console.log('⏰ [cron] Firing weekly gap-heal (Monday 09:30)');
    withAdvisoryLock(LOCK_WEEKLY_HEAL, 'weekly gap-heal', runWeeklyHeal)
      .catch(err => console.error('❌ [cron] Weekly gap-heal failed:', err.message));
  }, { scheduled: true, timezone: tz });

  cron.schedule('15 9 * * *', () => {
    console.log('⏰ [cron] Daily health check (09:15)');
    withAdvisoryLock(LOCK_HEALTH_ALERT, 'daily health check', sendHealthSummaryIfNeeded)
      .catch(err => console.error('❌ [cron] Daily health check failed:', err.message));
  }, { scheduled: true, timezone: tz });

  status.schedulerActive = true;
  console.log(`⏰  Scheduled: daily receipts sync 00:05, items sync 08:45, weekly gap-heal Monday 09:30, health check 09:15 (${tz})\n`);

  if (env === 'PROD') {
    withAdvisoryLock(LOCK_DAILY_SYNC, 'boot catch-up', runCatchupIfNeeded)
      .catch(err => console.error('❌ [cron] Catch-up failed:', err.message));
  }
}

function getSchedulerStatus() {
  return { ...status, nextRunAt: nextRunAt() };
}

module.exports = {
  startScheduler, getSchedulerStatus,
  runDailySync, runWeeklyHeal, runCatchupIfNeeded, runItemsSync,
};

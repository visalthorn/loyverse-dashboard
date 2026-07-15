const cron   = require('node-cron');
const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
const pool   = require('../../db');
const { tz, env } = require('../../config');
const { toCambodiaTime } = require('../../utils/date');
const { syncYesterdayReceipts } = require('./receipts');

dayjs.extend(utc);
dayjs.extend(tzPlug);

// In-memory scheduler health, exposed via GET /api/sync/status.
const status = {
  serverStartedAt: new Date().toISOString(),
  schedulerActive: false,
  lastCronFireAt:  null,
};

// Next 00:05 in Cambodia time as an ISO timestamp.
function nextRunAt() {
  const now = dayjs().tz(tz);
  let next = now.hour(0).minute(5).second(0).millisecond(0);
  if (!next.isAfter(now)) next = next.add(1, 'day');
  return next.toISOString();
}

async function yesterdayHasReceipts() {
  const yesterday = dayjs().tz(tz).subtract(1, 'day');
  const r = await pool.query(
    `SELECT 1 FROM receipts WHERE CAST(receipt_date AS date) = CAST($1 AS date) LIMIT 1`,
    [toCambodiaTime(yesterday.toISOString())]
  );
  return r.rowCount > 0;
}

// If the app was down over the 00:05 tick, the run is lost — heal it on boot.
// No sync_logs row is written when nothing is missing, so restarts stay quiet.
async function runCatchupIfNeeded() {
  if (await yesterdayHasReceipts()) {
    console.log('⏭  [cron] Catch-up not needed — yesterday already synced');
    return { ran: false };
  }
  console.log('🩹 [cron] Missed run detected — running catch-up sync');
  const result = await syncYesterdayReceipts('catchup');
  return { ran: true, result };
}

function startScheduler() {
  cron.schedule('5 0 * * *', () => {
    status.lastCronFireAt = new Date().toISOString();
    console.log('⏰ [cron] Firing daily receipts sync');
    syncYesterdayReceipts('auto');
  }, { scheduled: true, timezone: tz });
  status.schedulerActive = true;
  console.log(`⏰  Auto-sync scheduled daily at 00:05 AM (${tz})\n`);

  if (env === 'PROD') {
    runCatchupIfNeeded().catch(err =>
      console.error('❌ [cron] Catch-up failed:', err.message));
  }
}

function getSchedulerStatus() {
  return { ...status, nextRunAt: nextRunAt() };
}

module.exports = { startScheduler, runCatchupIfNeeded, getSchedulerStatus };

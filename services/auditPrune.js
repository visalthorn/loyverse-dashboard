const cron = require('node-cron');
const pool = require('../db');
const { tz } = require('../config');

// Retention: keep 12 months of audit_log, delete anything older. Runs
// monthly rather than daily -- this table is a compliance/accountability
// record, not something that needs same-day cleanup, and a monthly cadence
// keeps it out of the noisier daily cron log (see services/sync/scheduler.js
// for the receipts jobs, services/stockAlert.js for the daily stock nudge).
const RETENTION_MONTHS = 12;

async function pruneAuditLog() {
  const { rowCount } = await pool.query(
    `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '${RETENTION_MONTHS} months'`
  );
  return { deleted: rowCount };
}

function startAuditPruneScheduler() {
  // 1st of the month, 03:00 Cambodia time -- off-hours, well clear of any
  // daytime traffic.
  cron.schedule('0 3 1 * *', () => {
    pruneAuditLog()
      .then(({ deleted }) => console.log(`🧹 [cron] Audit log prune — deleted ${deleted} row(s) older than ${RETENTION_MONTHS} months`))
      .catch(err => console.error('❌ [cron] Audit log prune failed:', err.message));
  }, { scheduled: true, timezone: tz });
  console.log(`🧹  Audit log prune scheduled monthly (1st, 03:00 ${tz}) — keeps ${RETENTION_MONTHS} months`);
}

module.exports = { pruneAuditLog, startAuditPruneScheduler, RETENTION_MONTHS };

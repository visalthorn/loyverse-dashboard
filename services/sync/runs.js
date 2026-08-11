const pool = require('../../db');

async function startSyncRun(syncDate, triggeredBy) {
  const r = await pool.query(
    `INSERT INTO sync_runs (sync_date, status, triggered_by, started_at)
     VALUES ($1, 'running', $2, NOW())
     RETURNING id`,
    [syncDate, triggeredBy]
  );
  return r.rows[0].id;
}

async function finishSyncRun(id, {
  status, receiptsFetched = null, receiptsInserted = null, receiptsUpdated = null,
  loyverseReportedCount = null, errorMessage = null,
}) {
  await pool.query(
    `UPDATE sync_runs SET
       status = $2, receipts_fetched = $3, receipts_inserted = $4, receipts_updated = $5,
       loyverse_reported_count = $6, error_message = $7, finished_at = NOW()
     WHERE id = $1`,
    [id, status, receiptsFetched, receiptsInserted, receiptsUpdated, loyverseReportedCount, errorMessage]
  );
}

// Most recent run per date within [startDate, endDate], for coverage reporting.
async function latestRunsInRange(startDate, endDate) {
  const r = await pool.query(
    `SELECT DISTINCT ON (sync_date)
       sync_date::text AS sync_date, status, started_at, finished_at,
       loyverse_reported_count, receipts_fetched, error_message
     FROM sync_runs
     WHERE sync_date BETWEEN $1::date AND $2::date
     ORDER BY sync_date, started_at DESC`,
    [startDate, endDate]
  );
  return r.rows;
}

module.exports = { startSyncRun, finishSyncRun, latestRunsInRange };

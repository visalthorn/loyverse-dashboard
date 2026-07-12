const pool = require('../../db');

async function writeSyncLog({ syncType, syncDate, status, triggeredBy, inserted, error }) {
  try {
    await pool.query(
      `INSERT INTO sync_logs (sync_type, sync_date, status, triggered_by, inserted, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [syncType, syncDate, status, triggeredBy, inserted, error || null]
    );
  } catch (err) {
    console.error('[sync] Failed to write sync_log:', err.message);
  }
}

module.exports = { writeSyncLog };

const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireRole, requireWrite } = require('../middleware/auth');
const { syncYesterdayReceipts, syncItems, syncPosDevices, getSchedulerStatus } = require('../services/sync');
const { tz } = require('../config');

router.post('/receipts', requireAuth, requireWrite('receipts'), async (req, res) => {
  try {
    const result = await syncYesterdayReceipts('manual');
    res.status(result.status === 'failed' ? 500 : 200).json(result);
  } catch (err) {
    console.error('❌ Receipts sync route error:', err.message);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

router.post('/items', requireAuth, requireWrite('items'), async (req, res) => {
  try {
    const result = await syncItems('manual');
    res.status(result.status === 'failed' ? 500 : 200).json(result);
  } catch (err) {
    console.error('❌ Items sync route error:', err.message);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

router.post('/pos-devices', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await syncPosDevices('manual');
    res.status(result.status === 'failed' ? 500 : 200).json(result);
  } catch (err) {
    console.error('❌ POS devices sync route error:', err.message);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

router.get('/logs', requireAuth, async (req, res) => {
  try {
    const limit  = Math.min(50, parseInt(req.query.limit) || 10);
    const params = [limit];
    let where = '';
    if (req.query.type) { where = 'WHERE sync_type = $2'; params.push(req.query.type); }
    const result = await pool.query(
      `SELECT id, sync_type, sync_date, status, triggered_by, inserted, error_message, created_at
       FROM sync_logs ${where}
       ORDER BY created_at DESC
       LIMIT $1`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error('sync logs GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', requireAuth, async (req, res) => {
  try {
    const sched = getSchedulerStatus();
    const [yRow, lastAuto, covered, coveredBy] = await Promise.all([
      pool.query(`SELECT ((NOW() AT TIME ZONE $1)::date - 1)::text AS y`, [tz]),
      pool.query(
        `SELECT sync_date::text AS sync_date, status, triggered_by, created_at
         FROM sync_logs
         WHERE sync_type = 'receipts' AND triggered_by IN ('auto', 'catchup')
         ORDER BY created_at DESC LIMIT 1`),
      pool.query(
        `SELECT 1 FROM receipts
         WHERE CAST(receipt_date AS date) = (NOW() AT TIME ZONE $1)::date - 1 LIMIT 1`, [tz]),
      pool.query(
        `SELECT triggered_by FROM sync_logs
         WHERE sync_type = 'receipts' AND status IN ('success', 'skipped')
           AND sync_date = (NOW() AT TIME ZONE $1)::date - 1
         ORDER BY created_at DESC LIMIT 1`, [tz]),
    ]);
    res.json({
      ...sched,
      yesterday: yRow.rows[0].y,
      lastAutoSync: lastAuto.rows[0] || null,
      yesterdayCovered: covered.rowCount > 0,
      yesterdayCoveredBy: covered.rowCount > 0 ? (coveredBy.rows[0]?.triggered_by ?? null) : null,
    });
  } catch (err) {
    console.error('sync status GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

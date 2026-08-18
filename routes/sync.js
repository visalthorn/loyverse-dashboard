const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireRole, requireWrite } = require('../middleware/auth');
const {
  syncYesterdayReceipts, syncReceiptsRange, MAX_RANGE_DAYS,
  syncItems, syncPosDevices, getSchedulerStatus, getReceiptsCoverage,
  listBackupBranches, syncYesterdayBackupReceipts, syncBackupReceiptsRange,
} = require('../services/sync');
const { tz } = require('../config');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.post('/receipts', requireAuth, requireWrite('receipts'), async (req, res) => {
  const { start_date, end_date } = req.body || {};
  const triggeredBy = req.user?.username || 'manual';
  try {
    if (start_date || end_date) {
      if (!DATE_RE.test(start_date || '') || !DATE_RE.test(end_date || ''))
        return res.status(400).json({ message: 'start_date and end_date are both required, as YYYY-MM-DD.' });

      const days = await syncReceiptsRange(start_date, end_date, triggeredBy);
      const overall = days.some(d => d.status === 'failed') ? 'failed'
        : days.some(d => d.status === 'partial') ? 'partial' : 'success';
      return res.status(overall === 'failed' ? 500 : 200).json({ status: overall, days });
    }

    const result = await syncYesterdayReceipts(triggeredBy);
    res.status(result.status === 'failed' ? 500 : 200).json(result);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    console.error('❌ Receipts sync route error:', err.message);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

// Per-day coverage for the last `days` Cambodia calendar dates -- see
// services/sync/coverage.js (also used by the weekly gap-heal cron and
// GET /api/health, so all three agree on what counts as a "gap").
router.get('/receipts/coverage', requireAuth, async (req, res) => {
  try {
    const numDays = Math.min(180, Math.max(1, parseInt(req.query.days) || 60));
    const coverage = await getReceiptsCoverage(numDays);
    res.json({ ...coverage, maxRangeDays: MAX_RANGE_DAYS });
  } catch (err) {
    console.error('sync receipts coverage GET error:', err);
    res.status(500).json({ error: err.message });
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

// Manual per-branch backup sync -- pulls from a SEPARATE Loyverse account
// (credentials in branch_loyverse_backup, set up by hand via SQL, no admin
// UI). Admin-only: exposes a second account's sync trigger and cross-branch
// data, same precedent as /pos-devices and branch CRUD.
router.get('/backup-branches', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const branches = await listBackupBranches();
    res.json(branches);
  } catch (err) {
    console.error('sync backup-branches GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/backup-receipts', requireAuth, requireRole('admin'), async (req, res) => {
  const { branch_id, start_date, end_date } = req.body || {};
  const branchId = parseInt(branch_id, 10);
  const triggeredBy = req.user?.username || 'manual';
  if (!Number.isInteger(branchId)) return res.status(400).json({ message: 'branch_id is required.' });

  try {
    if (start_date || end_date) {
      if (!DATE_RE.test(start_date || '') || !DATE_RE.test(end_date || ''))
        return res.status(400).json({ message: 'start_date and end_date are both required, as YYYY-MM-DD.' });

      const days = await syncBackupReceiptsRange(branchId, start_date, end_date, triggeredBy);
      const overall = days.some(d => d.status === 'failed') ? 'failed'
        : days.some(d => d.status === 'partial') ? 'partial' : 'success';
      return res.status(overall === 'failed' ? 500 : 200).json({ status: overall, days });
    }

    const result = await syncYesterdayBackupReceipts(branchId, triggeredBy);
    res.status(result.status === 'failed' ? 500 : 200).json(result);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    console.error('❌ Backup receipts sync route error:', err.message);
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
         WHERE sync_type = 'receipts' AND triggered_by IN ('auto', 'catchup', 'scheduler')
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

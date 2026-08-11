const router = require('express').Router();
const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
const pool   = require('../db');
const { requireAuth, requireRole, requireWrite } = require('../middleware/auth');
const {
  syncYesterdayReceipts, syncReceiptsRange, MAX_RANGE_DAYS, latestRunsInRange,
  syncItems, syncPosDevices, getSchedulerStatus,
} = require('../services/sync');
const { tz } = require('../config');

dayjs.extend(utc);
dayjs.extend(tzPlug);

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

// Per-day coverage for the last `days` Cambodia calendar dates (ending
// yesterday -- today is still accumulating in Loyverse, so it isn't a
// meaningful "gap" yet). Backed by sync_runs where available; dates synced
// before that table existed fall back to "has any receipts" as a coarser
// signal so old history doesn't show up as a wall of false gaps.
router.get('/receipts/coverage', requireAuth, async (req, res) => {
  try {
    const numDays = Math.min(180, Math.max(1, parseInt(req.query.days) || 60));
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

    res.json({ start: startStr, end: endStr, maxRangeDays: MAX_RANGE_DAYS, days });
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

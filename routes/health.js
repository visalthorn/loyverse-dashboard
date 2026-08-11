const router = require('express').Router();
const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
const pool   = require('../db');
const { tz } = require('../config');
const { getReceiptsCoverage } = require('../services/sync');

dayjs.extend(utc);
dayjs.extend(tzPlug);

// Unauthenticated (uptime monitors can't log in) but deliberately returns no
// receipt data, error text, or anything else sensitive -- just dates, a
// count and a boolean.
router.get('/', async (req, res) => {
  try {
    await pool.query('SELECT 1');
  } catch {
    return res.status(503).json({ db: 'error', last_successful_sync: null, days_since_sync: null, gaps_14d: null });
  }

  try {
    const [lastSync, coverage] = await Promise.all([
      pool.query(`SELECT MAX(CAST(receipt_date AS date))::text AS d FROM receipts`),
      getReceiptsCoverage(14),
    ]);

    const lastSuccessfulSync = lastSync.rows[0].d;
    const daysSinceSync = lastSuccessfulSync
      ? dayjs().tz(tz).startOf('day').diff(dayjs.tz(lastSuccessfulSync, tz).startOf('day'), 'day')
      : null;
    const gaps14d = coverage.days.filter(d => d.gap).length;

    res.json({
      db: 'ok',
      last_successful_sync: lastSuccessfulSync,
      days_since_sync: daysSinceSync,
      gaps_14d: gaps14d,
    });
  } catch (err) {
    console.error('health GET error:', err.message);
    res.status(503).json({ db: 'ok', last_successful_sync: null, days_since_sync: null, gaps_14d: null });
  }
});

module.exports = router;

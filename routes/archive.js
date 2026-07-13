const router = require('express').Router();
const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
const pool   = require('../db');
const { tz } = require('../config');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rebuildSummaries } = require('../services/sync');

dayjs.extend(utc);
dayjs.extend(tzPlug);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const RANGE_SQL = table => `
  SELECT COUNT(*) AS count,
         MIN(DATE(receipt_date)) AS min_day,
         MAX(DATE(receipt_date)) AS max_day
  FROM ${table}`;

router.get('/status', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const [live, archive] = await Promise.all([
      pool.query(RANGE_SQL('receipts')),
      pool.query(RANGE_SQL('receipts_archive')),
    ]);
    const body = { live: live.rows[0], archive: archive.rows[0] };
    if (DATE_RE.test(req.query.cutoff || '')) {
      const affected = await pool.query(
        `SELECT COUNT(*) AS n FROM receipts WHERE DATE(receipt_date) <= $1`, [req.query.cutoff]);
      body.affected = parseInt(affected.rows[0].n);
    }
    res.json(body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { cutoff } = req.body || {};
  if (!DATE_RE.test(cutoff || '')) {
    return res.status(400).json({ error: 'cutoff must be YYYY-MM-DD' });
  }
  const maxCutoff = dayjs().tz(tz).subtract(30, 'day').format('YYYY-MM-DD');
  if (cutoff > maxCutoff) {
    return res.status(400).json({ error: `cutoff must be at least 30 days in the past (max ${maxCutoff})` });
  }

  try {
    const range = await pool.query(
      `SELECT MIN(DATE(receipt_date)) AS min_day, MAX(DATE(receipt_date)) AS max_day
       FROM receipts WHERE DATE(receipt_date) <= $1`, [cutoff]);
    const { min_day, max_day } = range.rows[0];
    if (!min_day) {
      return res.json({ status: 'skipped', moved: { receipts: 0, items: 0, payments: 0 } });
    }

    // Guarantee summary coverage BEFORE moving anything out of the live tables.
    const fmt = d => dayjs(d).format('YYYY-MM-DD');
    await rebuildSummaries(fmt(min_day), fmt(max_day), 'archive');

    const client = await pool.connect();
    let moved;
    try {
      await client.query('BEGIN');
      const items = await client.query(`
        INSERT INTO receipt_items_archive
        SELECT ri.* FROM receipt_items ri
        JOIN receipts r ON r.receipt_number = ri.receipt_number
        WHERE DATE(r.receipt_date) <= $1
        ON CONFLICT DO NOTHING
      `, [cutoff]);
      const payments = await client.query(`
        INSERT INTO receipt_payments_archive
        SELECT rp.* FROM receipt_payments rp
        JOIN receipts r ON r.receipt_number = rp.receipt_number
        WHERE DATE(r.receipt_date) <= $1
        ON CONFLICT DO NOTHING
      `, [cutoff]);
      const receipts = await client.query(`
        INSERT INTO receipts_archive
        SELECT * FROM receipts WHERE DATE(receipt_date) <= $1
        ON CONFLICT DO NOTHING
      `, [cutoff]);
      await client.query(`
        DELETE FROM receipt_items ri USING receipts r
        WHERE r.receipt_number = ri.receipt_number AND DATE(r.receipt_date) <= $1
      `, [cutoff]);
      await client.query(`
        DELETE FROM receipt_payments rp USING receipts r
        WHERE r.receipt_number = rp.receipt_number AND DATE(r.receipt_date) <= $1
      `, [cutoff]);
      await client.query(`DELETE FROM receipts WHERE DATE(receipt_date) <= $1`, [cutoff]);
      await client.query('COMMIT');
      moved = { receipts: receipts.rowCount, items: items.rowCount, payments: payments.rowCount };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    console.log(`🗄️  [archive] Moved ${moved.receipts} receipts (≤ ${cutoff}) to archive`);
    res.json({ status: 'success', moved });
  } catch (err) {
    console.error('❌ Archive route error:', err.message);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

module.exports = router;

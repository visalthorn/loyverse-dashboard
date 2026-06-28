const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireWrite } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  const year  = parseInt(req.query.year);
  const month = parseInt(req.query.month);
  if (!year || !month || month < 1 || month > 12)
    return res.status(400).json({ message: 'Valid year and month required.' });
  try {
    const result = await pool.query(`
      SELECT ss.staff_id, ss.schedule_date, ss.shift
      FROM staff_schedule ss
      WHERE EXTRACT(YEAR  FROM ss.schedule_date) = $1
        AND EXTRACT(MONTH FROM ss.schedule_date) = $2
      ORDER BY ss.staff_id ASC, ss.schedule_date ASC
    `, [year, month]);
    res.json(result.rows);
  } catch (err) {
    console.error('Schedule GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/', requireAuth, requireWrite('staff'), async (req, res) => {
  const { staff_id, schedule_date, shift } = req.body;
  if (!staff_id || !schedule_date)
    return res.status(400).json({ message: 'staff_id and schedule_date are required.' });
  if (shift !== null && shift !== undefined && !['M', 'A', 'Off'].includes(shift))
    return res.status(400).json({ message: 'Invalid shift. Use M, A, Off, or null to clear.' });
  try {
    if (!shift) {
      await pool.query(
        'DELETE FROM staff_schedule WHERE staff_id=$1 AND schedule_date=$2',
        [staff_id, schedule_date]
      );
      return res.json({ deleted: true });
    }
    const result = await pool.query(`
      INSERT INTO staff_schedule (staff_id, schedule_date, shift)
      VALUES ($1, $2, $3)
      ON CONFLICT (staff_id, schedule_date)
      DO UPDATE SET shift=$3, updated_at=NOW()
      RETURNING *
    `, [staff_id, schedule_date, shift]);
    res.json({ entry: result.rows[0] });
  } catch (err) {
    console.error('Schedule PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk upsert/clear entries for roster fill
router.put('/bulk', requireAuth, requireWrite('staff'), async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0)
    return res.status(400).json({ message: 'entries array is required.' });

  const validShifts = ['M', 'A', 'Off'];
  for (const e of entries) {
    if (!e.staff_id || !e.schedule_date)
      return res.status(400).json({ message: 'Each entry requires staff_id and schedule_date.' });
    if (e.shift != null && !validShifts.includes(e.shift))
      return res.status(400).json({ message: `Invalid shift: ${e.shift}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      if (!e.shift) {
        await client.query(
          'DELETE FROM staff_schedule WHERE staff_id=$1 AND schedule_date=$2',
          [e.staff_id, e.schedule_date]
        );
      } else {
        await client.query(`
          INSERT INTO staff_schedule (staff_id, schedule_date, shift)
          VALUES ($1, $2, $3)
          ON CONFLICT (staff_id, schedule_date)
          DO UPDATE SET shift=$3, updated_at=NOW()
        `, [e.staff_id, e.schedule_date, e.shift]);
      }
    }
    await client.query('COMMIT');
    res.json({ updated: entries.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Schedule bulk error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;

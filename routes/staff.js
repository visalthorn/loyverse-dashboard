const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireWrite } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, staff_id, full_name, position,
             TO_CHAR(join_date,        'YYYY-MM-DD') AS join_date,
             salary, salary_ccy,
             phone, loan_amount, loan_ccy, is_active, notes,
             default_shift,
             TO_CHAR(last_salary_date, 'YYYY-MM-DD') AS last_salary_date,
             created_at
      FROM staff ORDER BY staff_id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Staff GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, requireWrite('staff'), async (req, res) => {
  const { staff_id, full_name, position, join_date, salary, salary_ccy,
          phone, loan_amount, loan_ccy, notes, default_shift } = req.body;
  if (!staff_id || !full_name)
    return res.status(400).json({ message: 'staff_id and full_name are required.' });
  try {
    const result = await pool.query(`
      INSERT INTO staff (staff_id, full_name, position, join_date, salary, salary_ccy,
                         phone, loan_amount, loan_ccy, notes, default_shift)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [staff_id, full_name, position || null, join_date || null,
        salary || 0, salary_ccy || 'USD', phone || null,
        loan_amount || 0, loan_ccy || 'KHR', notes || null,
        default_shift || null]);
    res.status(201).json({ staff: result.rows[0] });
  } catch (err) {
    console.error('Staff POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, requireWrite('staff'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { staff_id, full_name, position, join_date, salary, salary_ccy,
          phone, loan_amount, loan_ccy, is_active, notes,
          default_shift, last_salary_date } = req.body;
  if (!id || !staff_id || !full_name)
    return res.status(400).json({ message: 'id, staff_id and full_name are required.' });
  try {
    const result = await pool.query(`
      UPDATE staff
      SET staff_id=$1, full_name=$2, position=$3, join_date=$4,
          salary=$5, salary_ccy=$6, phone=$7, loan_amount=$8, loan_ccy=$9,
          is_active=$10, notes=$11, default_shift=$12, last_salary_date=$13,
          updated_at=NOW()
      WHERE id=$14 RETURNING *
    `, [staff_id, full_name, position || null, join_date || null,
        salary || 0, salary_ccy || 'USD', phone || null,
        loan_amount || 0, loan_ccy || 'KHR',
        is_active !== undefined ? is_active : true,
        notes || null, default_shift || null, last_salary_date || null, id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Staff not found.' });
    res.json({ staff: result.rows[0] });
  } catch (err) {
    console.error('Staff PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Mark last salary date without touching other fields
router.put('/:id/salary-mark', requireAuth, requireWrite('staff'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid id.' });
  const { last_salary_date } = req.body;
  try {
    const result = await pool.query(
      `UPDATE staff SET last_salary_date=$1, updated_at=NOW()
       WHERE id=$2 RETURNING id, last_salary_date`,
      [last_salary_date || null, id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'Staff not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Staff salary-mark error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, requireWrite('staff'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid id.' });
  try {
    const result = await pool.query('DELETE FROM staff WHERE id=$1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Staff not found.' });
    res.json({ deleted: true, id });
  } catch (err) {
    console.error('Staff DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

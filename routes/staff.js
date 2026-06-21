const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireWrite } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, staff_id, full_name, position, join_date, salary, salary_ccy,
             phone, loan_amount, loan_ccy, is_active, notes, created_at
      FROM staff ORDER BY staff_id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Staff GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, requireWrite('staff'), async (req, res) => {
  const { staff_id, full_name, position, join_date, salary, salary_ccy, phone, loan_amount, loan_ccy, notes } = req.body;
  if (!staff_id || !full_name)
    return res.status(400).json({ message: 'staff_id and full_name are required.' });
  try {
    const result = await pool.query(`
      INSERT INTO staff (staff_id, full_name, position, join_date, salary, salary_ccy, phone, loan_amount, loan_ccy, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [staff_id, full_name, position || null, join_date || null, salary || 0, salary_ccy || 'USD', phone || null, loan_amount || 0, loan_ccy || 'KHR', notes || null]);
    res.status(201).json({ staff: result.rows[0] });
  } catch (err) {
    console.error('Staff POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, requireWrite('staff'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { staff_id, full_name, position, join_date, salary, salary_ccy, phone, loan_amount, loan_ccy, is_active, notes } = req.body;
  if (!id || !staff_id || !full_name)
    return res.status(400).json({ message: 'id, staff_id and full_name are required.' });
  try {
    const result = await pool.query(`
      UPDATE staff
      SET staff_id=$1, full_name=$2, position=$3, join_date=$4, salary=$5, salary_ccy=$6,
          phone=$7, loan_amount=$8, loan_ccy=$9, is_active=$10, notes=$11, updated_at=NOW()
      WHERE id=$12 RETURNING *
    `, [staff_id, full_name, position || null, join_date || null, salary || 0, salary_ccy || 'USD',
        phone || null, loan_amount || 0, loan_ccy || 'KHR',
        is_active !== undefined ? is_active : true, notes || null, id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Staff not found.' });
    res.json({ staff: result.rows[0] });
  } catch (err) {
    console.error('Staff PUT error:', err);
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

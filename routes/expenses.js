const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireWrite } = require('../middleware/auth');
const { insertExpense } = require('../services/expenses');

async function validBranchId(branch_id) {
  if (branch_id == null) return { ok: true, value: null };
  const id = parseInt(branch_id);
  if (!Number.isInteger(id)) return { ok: false };
  const r = await pool.query('SELECT 1 FROM branches WHERE id = $1', [id]);
  return r.rowCount ? { ok: true, value: id } : { ok: false };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page) || 1);
    const per_page = Math.min(1000, Math.max(1, parseInt(req.query.per_page) || 10));
    const offset   = (page - 1) * per_page;

    const filters = [];
    const params  = [];
    let i = 1;
    if (req.query.start) { filters.push(`e.expense_date >= $${i++}`); params.push(req.query.start); }
    if (req.query.end)   { filters.push(`e.expense_date <= $${i++}`); params.push(req.query.end); }
    if (req.query.branch_id) { filters.push(`e.branch_id = $${i++}`); params.push(parseInt(req.query.branch_id)); }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [totalRes, totalAmountRes, result] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM expenses e ${where}`, params),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total_amount FROM expenses e ${where}`, params),
      pool.query(`
        SELECT e.id, e.expense_date, e.amount, e.remark, e.expense_by, e.created_at,
               e.branch_id, b.name AS branch_name
        FROM expenses e LEFT JOIN branches b ON b.id = e.branch_id ${where}
        ORDER BY e.expense_date DESC, e.created_at DESC
        LIMIT $${i} OFFSET $${i + 1}
      `, [...params, per_page, offset]),
    ]);

    res.json({
      items:        result.rows,
      total:        parseInt(totalRes.rows[0].count || 0),
      total_amount: parseFloat(totalAmountRes.rows[0].total_amount || 0),
      page,
      per_page,
    });
  } catch (err) {
    console.error('Expenses GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, requireWrite('expenses'), async (req, res) => {
  const { expense_date, amount, remark, expense_by, branch_id } = req.body;
  if (!expense_date || !amount || !expense_by)
    return res.status(400).json({ message: 'expense_date, amount and expense_by are required.' });
  try {
    const branch = await validBranchId(branch_id);
    if (!branch.ok) return res.status(400).json({ message: 'Unknown branch.' });
    const expense = await insertExpense({ expense_date, amount, remark, expense_by, branch_id: branch.value });
    res.status(201).json({ expense });
  } catch (err) {
    console.error('Expenses POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, requireWrite('expenses'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { expense_date, amount, remark, expense_by, branch_id } = req.body;
  if (!id || !expense_date || !amount || !expense_by)
    return res.status(400).json({ message: 'id, expense_date, amount and expense_by are required.' });
  try {
    const branch = await validBranchId(branch_id);
    if (!branch.ok) return res.status(400).json({ message: 'Unknown branch.' });
    const result = await pool.query(`
      UPDATE expenses SET expense_date=$1, amount=$2, remark=$3, expense_by=$4,
             branch_id = COALESCE($5, branch_id)
      WHERE id=$6 RETURNING id, expense_date, amount, remark, expense_by, branch_id, created_at
    `, [expense_date, amount, remark || null, expense_by, branch.value, id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Expense not found.' });
    res.json({ expense: result.rows[0] });
  } catch (err) {
    console.error('Expenses PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, requireWrite('expenses'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid id.' });
  try {
    const result = await pool.query('DELETE FROM expenses WHERE id=$1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Expense not found.' });
    res.json({ deleted: true, id });
  } catch (err) {
    console.error('Expenses DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireWrite } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const { previewBackfill, runBackfill } = require('../services/recurringExpenses');

async function validBranchId(branch_id) {
  if (branch_id == null) return { ok: true, value: null };
  const id = Number(branch_id);
  if (!Number.isInteger(id)) return { ok: false };
  const r = await pool.query('SELECT 1 FROM branches WHERE id = $1', [id]);
  return r.rowCount ? { ok: true, value: id } : { ok: false };
}

function validateTemplateBody(body) {
  const { name, amount, frequency, day_of_month, day_of_week, start_date } = body;
  if (!name || !amount || !frequency || !start_date) return 'name, amount, frequency and start_date are required.';
  if (!['monthly', 'weekly'].includes(frequency)) return 'frequency must be "monthly" or "weekly".';
  if (frequency === 'monthly') {
    const d = Number(day_of_month);
    if (!Number.isInteger(d) || d < 1 || d > 31) return 'day_of_month must be an integer 1-31 for a monthly template.';
  } else {
    const d = Number(day_of_week);
    if (!Number.isInteger(d) || d < 0 || d > 6) return 'day_of_week must be an integer 0-6 (Sun-Sat) for a weekly template.';
  }
  return null;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT re.*, b.name AS branch_name,
        (SELECT COUNT(*) FROM expenses e WHERE e.recurring_expense_id = re.id) AS generated_count
      FROM recurring_expenses re
      LEFT JOIN branches b ON b.id = re.branch_id
      ORDER BY re.is_active DESC, re.name ASC
    `);
    res.json({ templates: rows });
  } catch (err) {
    console.error('Recurring expenses GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, requireWrite('expenses'), async (req, res) => {
  const errMsg = validateTemplateBody(req.body);
  if (errMsg) return res.status(400).json({ message: errMsg });

  const { name, amount, category, frequency, start_date, end_date, branch_id, is_active } = req.body;
  const day_of_month = frequency === 'monthly' ? Number(req.body.day_of_month) : null;
  const day_of_week  = frequency === 'weekly'  ? Number(req.body.day_of_week)  : null;

  try {
    const branch = await validBranchId(branch_id);
    if (!branch.ok) return res.status(400).json({ message: 'Unknown branch.' });

    const result = await pool.query(`
      INSERT INTO recurring_expenses (name, amount, category, frequency, day_of_month, day_of_week, branch_id, start_date, end_date, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [name, amount, category || null, frequency, day_of_month, day_of_week, branch.value, start_date, end_date || null, is_active !== false]);

    const template = result.rows[0];
    await writeAudit({ req, action: 'create', entity: 'recurring_expenses', entityId: template.id, after: template });
    res.status(201).json({ template });
  } catch (err) {
    console.error('Recurring expenses POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, requireWrite('expenses'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid id.' });
  const errMsg = validateTemplateBody(req.body);
  if (errMsg) return res.status(400).json({ message: errMsg });

  const { name, amount, category, frequency, start_date, end_date, branch_id, is_active } = req.body;
  const day_of_month = frequency === 'monthly' ? Number(req.body.day_of_month) : null;
  const day_of_week  = frequency === 'weekly'  ? Number(req.body.day_of_week)  : null;

  try {
    const branch = await validBranchId(branch_id);
    if (!branch.ok) return res.status(400).json({ message: 'Unknown branch.' });

    const before = await pool.query('SELECT * FROM recurring_expenses WHERE id=$1', [id]);
    if (!before.rows.length) return res.status(404).json({ message: 'Template not found.' });

    const result = await pool.query(`
      UPDATE recurring_expenses
      SET name=$1, amount=$2, category=$3, frequency=$4, day_of_month=$5, day_of_week=$6,
          branch_id=$7, start_date=$8, end_date=$9, is_active=$10
      WHERE id=$11 RETURNING *
    `, [name, amount, category || null, frequency, day_of_month, day_of_week, branch.value, start_date, end_date || null, is_active !== false, id]);

    await writeAudit({ req, action: 'update', entity: 'recurring_expenses', entityId: id, before: before.rows[0], after: result.rows[0] });
    res.json({ template: result.rows[0] });
  } catch (err) {
    console.error('Recurring expenses PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, requireWrite('expenses'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid id.' });
  try {
    const result = await pool.query('DELETE FROM recurring_expenses WHERE id=$1 RETURNING *', [id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Template not found.' });
    await writeAudit({ req, action: 'delete', entity: 'recurring_expenses', entityId: id, before: result.rows[0] });
    res.json({ deleted: true, id });
  } catch (err) {
    console.error('Recurring expenses DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Read-only: what backfill WOULD generate. The frontend shows this count and
// waits for an explicit confirm before hitting POST .../backfill below.
router.get('/:id/backfill-preview', requireAuth, requireWrite('expenses'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid id.' });
  try {
    const result = await previewBackfill(id);
    if (!result) return res.status(404).json({ message: 'Template not found.' });
    res.json({ count: result.count, dates: result.dates });
  } catch (err) {
    console.error('Backfill preview error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/backfill', requireAuth, requireWrite('expenses'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid id.' });
  try {
    const result = await runBackfill(id);
    if (!result) return res.status(404).json({ message: 'Template not found.' });
    await writeAudit({ req, action: 'update', entity: 'recurring_expenses', entityId: id, after: { backfill_inserted: result.inserted, backfill_checked: result.checked } });
    res.json(result);
  } catch (err) {
    console.error('Backfill run error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

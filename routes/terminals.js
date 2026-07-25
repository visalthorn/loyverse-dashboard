const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool   = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('admin'));

const parseId = v => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && String(n) === String(v) ? n : null;
};

function generatePasscode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

router.post('/pos-terminals/:id/reset-passcode', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Terminal not found' });
  try {
    const passcode = generatePasscode();
    const hash = await bcrypt.hash(passcode, 10);
    const result = await pool.query(
      `UPDATE pos_terminals SET passcode_hash = $1, updated_at = NOW()
       WHERE id = $2 AND deleted_at IS NULL RETURNING id`,
      [hash, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Terminal not found' });
    res.json({ passcode });
  } catch (err) {
    console.error('pos-terminal reset-passcode error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/kds-terminals/:id/reset-passcode', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Terminal not found' });
  try {
    const passcode = generatePasscode();
    const hash = await bcrypt.hash(passcode, 10);
    const result = await pool.query(
      `UPDATE kds_terminals SET passcode_hash = $1, updated_at = NOW()
       WHERE id = $2 AND deleted_at IS NULL RETURNING id`,
      [hash, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Terminal not found' });
    res.json({ passcode });
  } catch (err) {
    console.error('kds-terminal reset-passcode error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/pos-terminals/:id/toggle', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Terminal not found' });
  try {
    const result = await pool.query(
      `UPDATE pos_terminals SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id, is_active`,
      [id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Terminal not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('pos-terminal toggle error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/kds-terminals/:id/toggle', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Terminal not found' });
  try {
    const result = await pool.query(
      `UPDATE kds_terminals SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id, is_active`,
      [id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Terminal not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('kds-terminal toggle error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/kds-terminals/:id/categories', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Terminal not found' });
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.custom_name
       FROM kds_terminal_categories ktc
       JOIN categories c ON c.id = ktc.category_id
       WHERE ktc.kds_terminal_id = $1
       ORDER BY c.name`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('kds-terminal categories GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/kds-terminals/:id/categories', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Terminal not found' });
  const categoryIds = Array.isArray(req.body.category_ids) ? req.body.category_ids : null;
  if (!categoryIds) return res.status(400).json({ error: 'category_ids must be an array.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const term = await client.query('SELECT id FROM kds_terminals WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!term.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Terminal not found' }); }

    await client.query('DELETE FROM kds_terminal_categories WHERE kds_terminal_id = $1', [id]);
    for (const categoryId of categoryIds) {
      await client.query(
        `INSERT INTO kds_terminal_categories (kds_terminal_id, category_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [id, categoryId]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, count: categoryIds.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('kds-terminal categories PUT error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;

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

// ─── Device management (Section 9 of the terminal-auth redesign) ───────────
// Dashboard-side visibility/control over the long-lived device tokens minted
// by POST /api/terminal/login. Gated the same as every other route in this
// file (requireAuth + requireRole('admin'), applied via router.use() above).

const TABLE_BY_TYPE = { pos: 'pos_terminals', kds: 'kds_terminals' };

router.get('/terminals/:type/:id/devices', async (req, res) => {
  const { type } = req.params;
  const id = parseId(req.params.id);
  if (!TABLE_BY_TYPE[type]) return res.status(400).json({ error: 'type must be pos or kds.' });
  if (id === null) return res.status(404).json({ error: 'Terminal not found' });
  try {
    const result = await pool.query(
      `SELECT id, device_label, user_agent, last_active_at, expires_at, created_at, revoked_at
       FROM terminal_devices WHERE terminal_type = $1 AND terminal_ref_id = $2 ORDER BY created_at DESC`,
      [type, id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('terminal devices GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/terminal-devices/:id/revoke', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Device not found' });
  try {
    const result = await pool.query(
      `UPDATE terminal_devices SET revoked_at = NOW(), revoked_by = $1
       WHERE id = $2 AND revoked_at IS NULL RETURNING id`,
      [req.user.username, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Device not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('terminal device revoke error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/terminals/:type/:id/revoke-all-devices', async (req, res) => {
  const { type } = req.params;
  const id = parseId(req.params.id);
  if (!TABLE_BY_TYPE[type]) return res.status(400).json({ error: 'type must be pos or kds.' });
  if (id === null) return res.status(404).json({ error: 'Terminal not found' });
  try {
    const result = await pool.query(
      `UPDATE terminal_devices SET revoked_at = NOW(), revoked_by = $1
       WHERE terminal_type = $2 AND terminal_ref_id = $3 AND revoked_at IS NULL RETURNING id`,
      [req.user.username, type, id]
    );
    res.json({ success: true, revoked_count: result.rowCount });
  } catch (err) {
    console.error('terminal revoke-all-devices error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/terminals/:type/:id/unlock', async (req, res) => {
  const { type } = req.params;
  const id = parseId(req.params.id);
  const table = TABLE_BY_TYPE[type];
  if (!table) return res.status(400).json({ error: 'type must be pos or kds.' });
  if (id === null) return res.status(404).json({ error: 'Terminal not found' });
  try {
    const result = await pool.query(
      `UPDATE ${table} SET failed_attempts = 0, locked_until = NULL WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Terminal not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('terminal unlock error:', err);
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
    const term = await client.query('SELECT id, branch_id FROM kds_terminals WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!term.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Terminal not found' }); }
    const branchId = term.rows[0].branch_id;

    if (categoryIds.length) {
      const conflicts = await client.query(`
        SELECT ktc.category_id, kt.terminal_id, kt.name
        FROM kds_terminal_categories ktc
        JOIN kds_terminals kt ON kt.id = ktc.kds_terminal_id
        WHERE ktc.branch_id = $1 AND ktc.kds_terminal_id != $2 AND ktc.category_id = ANY($3::uuid[])
      `, [branchId, id, categoryIds]);
      if (conflicts.rowCount) {
        await client.query('ROLLBACK');
        const first = conflicts.rows[0];
        return res.status(409).json({
          error: `Already assigned to ${first.name || first.terminal_id}.`,
          conflicts: conflicts.rows,
        });
      }
    }

    await client.query('DELETE FROM kds_terminal_categories WHERE kds_terminal_id = $1', [id]);
    for (const categoryId of categoryIds) {
      await client.query(
        `INSERT INTO kds_terminal_categories (kds_terminal_id, category_id, branch_id) VALUES ($1, $2, $3)`,
        [id, categoryId, branchId]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, count: categoryIds.length });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Category already assigned to another KDS terminal in this branch.' });
    console.error('kds-terminal categories PUT error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;

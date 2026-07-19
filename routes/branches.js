const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// Non-admin: branch names for filters/forms. Everything below the gate stays admin-only.
router.get('/options', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, is_default FROM branches ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error('branches options GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.use(requireAuth, requireRole('admin'));

const parseId = v => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && String(n) === String(v) ? n : null;
};

// address/google_maps_url: trim, empty -> NULL; url must be http(s) when present.
function parseMeta(body) {
  const address = (body.address || '').trim() || null;
  const url     = (body.google_maps_url || '').trim() || null;
  if (url && !/^https?:\/\//.test(url)) return { error: 'Google Maps link must start with http:// or https://' };
  return { address, google_maps_url: url };
}

// NOTE: /devices routes are registered before /:id so they never collide.

router.get('/devices', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pd.id, pd.name, pd.store_id, pd.activated, pd.branch_id, b.name AS branch_name
      FROM pos_devices pd
      LEFT JOIN branches b ON b.id = pd.branch_id
      WHERE pd.deleted_at IS NULL
      ORDER BY pd.name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('branches devices GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/devices/:id', async (req, res) => {
  const branchId = req.body.branch_id ?? null;
  try {
    if (branchId !== null) {
      if (!Number.isInteger(branchId)) return res.status(400).json({ error: 'branch_id must be an integer or null' });
      const b = await pool.query('SELECT 1 FROM branches WHERE id = $1', [branchId]);
      if (!b.rowCount) return res.status(400).json({ error: 'Unknown branch' });
    }
    const result = await pool.query(
      'UPDATE pos_devices SET branch_id = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING id',
      [branchId, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Device not found' });
    res.json({ success: true });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Device not found' });
    console.error('branches device PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.id, b.name, b.address, b.google_maps_url, b.is_default,
             COUNT(pd.id)::int AS device_count
      FROM branches b
      LEFT JOIN pos_devices pd ON pd.branch_id = b.id AND pd.deleted_at IS NULL
      GROUP BY b.id, b.name, b.address, b.google_maps_url, b.is_default
      ORDER BY b.name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('branches GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name || name.length > 100) return res.status(400).json({ error: 'Branch name is required (max 100 chars).' });
  const meta = parseMeta(req.body);
  if (meta.error) return res.status(400).json({ error: meta.error });
  try {
    const result = await pool.query(
      'INSERT INTO branches (name, address, google_maps_url) VALUES ($1, $2, $3) RETURNING id, name, address, google_maps_url, is_default',
      [name, meta.address, meta.google_maps_url]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A branch with this name already exists.' });
    console.error('branches POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Branch not found' });
  const name = (req.body.name || '').trim();
  if (!name || name.length > 100) return res.status(400).json({ error: 'Branch name is required (max 100 chars).' });
  const meta = parseMeta(req.body);
  if (meta.error) return res.status(400).json({ error: meta.error });
  try {
    const result = await pool.query(
      `UPDATE branches SET name = $1, address = $2, google_maps_url = $3, updated_at = NOW()
       WHERE id = $4 RETURNING id, name, address, google_maps_url, is_default`,
      [name, meta.address, meta.google_maps_url, id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Branch not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A branch with this name already exists.' });
    console.error('branches PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Branch not found' });
  try {
    const result = await pool.query('DELETE FROM branches WHERE id = $1 RETURNING id', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Branch not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('branches DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

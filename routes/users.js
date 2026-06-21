const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool   = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, username, email, full_name, role, is_active, created_at FROM users ORDER BY id ASC'
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, email, full_name, role } = req.body;
  if (!username || !password || !email)
    return res.status(400).json({ message: 'username, password and email are required.' });
  if (!['admin', 'manager'].includes(role))
    return res.status(400).json({ message: 'role must be admin or manager.' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (username, password, email, full_name, role)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, username, email, full_name, role, is_active, created_at`,
      [username.toLowerCase().trim(), hash, email.trim(), full_name || null, role]
    );
    res.status(201).json({ user: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'Username or email already exists.' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { email, full_name, role, is_active, password } = req.body;
  if (!id) return res.status(400).json({ message: 'Invalid id.' });
  if (id === req.user.id && role && role !== 'admin')
    return res.status(400).json({ message: 'Cannot change your own role.' });
  try {
    let r;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      r = await pool.query(
        `UPDATE users SET email=$1, full_name=$2, role=$3, is_active=$4, password=$5
         WHERE id=$6 RETURNING id, username, email, full_name, role, is_active`,
        [email, full_name || null, role, is_active !== undefined ? is_active : true, hash, id]
      );
    } else {
      r = await pool.query(
        `UPDATE users SET email=$1, full_name=$2, role=$3, is_active=$4
         WHERE id=$5 RETURNING id, username, email, full_name, role, is_active`,
        [email, full_name || null, role, is_active !== undefined ? is_active : true, id]
      );
    }
    if (!r.rows.length) return res.status(404).json({ message: 'User not found.' });
    res.json({ user: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid id.' });
  if (id === req.user.id) return res.status(400).json({ message: 'Cannot delete your own account.' });
  try {
    const r = await pool.query('DELETE FROM users WHERE id=$1 RETURNING id', [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'User not found.' });
    res.json({ deleted: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

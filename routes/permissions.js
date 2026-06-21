const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query('SELECT role, page, can_write FROM role_permissions ORDER BY role, page');
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { role, page, can_write } = req.body;
  if (!role || !page) return res.status(400).json({ message: 'role and page are required.' });
  try {
    const r = await pool.query(
      `INSERT INTO role_permissions (role, page, can_write) VALUES ($1,$2,$3)
       ON CONFLICT (role, page) DO UPDATE SET can_write=$3 RETURNING *`,
      [role, page, Boolean(can_write)]
    );
    res.json({ permission: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

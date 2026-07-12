const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const pool   = require('../db');
const { jwtSecret, jwtExpires } = require('../config');
const { requireAuth } = require('../middleware/auth');

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: 'Username and password are required.' });
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND is_active = true LIMIT 1',
      [username.toLowerCase().trim()]
    );
    if (!result.rows.length)
      return res.status(401).json({ message: 'Invalid username or password.' });

    const user = result.rows[0];
    if (!user.password || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ message: 'Invalid username or password.' });

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      jwtSecret,
      { expiresIn: jwtExpires }
    );
    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, fullName: user.full_name },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

router.get('/verify', requireAuth, async (req, res) => {
  try {
    const pages = ['expenses', 'staff', 'receipts', 'items'];
    const permissions = {};

    if (req.user.role === 'admin') {
      pages.forEach(p => { permissions[p] = { can_write: true }; });
    } else {
      pages.forEach(p => { permissions[p] = { can_write: false }; });
      if (req.user.role === 'manager') {
        const r = await pool.query(
          'SELECT page, can_write FROM role_permissions WHERE role=$1', ['manager']
        );
        r.rows.forEach(row => { permissions[row.page] = { can_write: row.can_write }; });
      }
    }
    res.json({ valid: true, user: req.user, permissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

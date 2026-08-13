const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const pool   = require('../db');
const { jwtSecret, jwtExpires } = require('../config');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { writeAudit } = require('../services/audit');

const loginRateLimit = rateLimit({ windowMs: 60 * 1000, max: 5 });

router.post('/login', loginRateLimit, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: 'Username and password are required.' });
  const normalizedUsername = username.toLowerCase().trim();
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND is_active = true LIMIT 1',
      [normalizedUsername]
    );
    if (!result.rows.length) {
      await writeAudit({ req, actorUsername: normalizedUsername, action: 'login_failed', entity: 'users', entityId: normalizedUsername });
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const user = result.rows[0];
    if (!user.password || !(await bcrypt.compare(password, user.password))) {
      await writeAudit({ req, actorUserId: user.id, actorUsername: user.username, action: 'login_failed', entity: 'users', entityId: user.id });
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      jwtSecret,
      { expiresIn: jwtExpires }
    );
    await writeAudit({ req, actorUserId: user.id, actorUsername: user.username, action: 'login', entity: 'users', entityId: user.id });
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

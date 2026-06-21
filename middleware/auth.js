const jwt  = require('jsonwebtoken');
const { jwtSecret } = require('../config');
const pool = require('../db');

function requireAuth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access denied. Please log in.' });
  try {
    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch {
    res.status(401).json({ message: 'Session expired. Please log in again.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({ message: 'Access denied.' });
    next();
  };
}

function requireWrite(page) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Unauthorized.' });
    if (req.user.role === 'admin') return next();
    if (req.user.role === 'manager') {
      try {
        const r = await pool.query(
          'SELECT can_write FROM role_permissions WHERE role=$1 AND page=$2',
          ['manager', page]
        );
        if (r.rows[0]?.can_write) return next();
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
    res.status(403).json({ message: 'Write access denied.' });
  };
}

module.exports = { requireAuth, requireRole, requireWrite };

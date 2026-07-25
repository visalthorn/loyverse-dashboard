const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const pool   = require('../db');
const { jwtSecretTerminal, jwtExpiresTerminal } = require('../config');
const { rateLimit } = require('../middleware/rateLimit');

// Keyed by terminal_id (not IP) -- a shop-floor tablet shares an IP with every
// other device on the same LAN, so IP-based limiting would lock out the whole
// shop after a few mistyped PINs on one unit.
const terminalLoginRateLimit = rateLimit({
  windowMs: 2 * 60 * 1000,
  max: 5,
  keyFn: req => (req.body && req.body.terminal_id) || req.ip,
});

router.post('/login', terminalLoginRateLimit, async (req, res) => {
  const { terminal_id, passcode } = req.body;
  if (!terminal_id || !passcode) {
    return res.status(400).json({ message: 'Invalid terminal ID or passcode.' });
  }

  try {
    const posResult = await pool.query(
      'SELECT * FROM pos_terminals WHERE terminal_id = $1 AND deleted_at IS NULL',
      [terminal_id]
    );
    const kdsResult = posResult.rowCount ? null : await pool.query(
      'SELECT * FROM kds_terminals WHERE terminal_id = $1 AND deleted_at IS NULL',
      [terminal_id]
    );

    const type    = posResult.rowCount ? 'pos' : (kdsResult && kdsResult.rowCount ? 'kds' : null);
    const record  = type === 'pos' ? posResult.rows[0] : (type === 'kds' ? kdsResult.rows[0] : null);

    if (!record || !record.is_active || !(await bcrypt.compare(passcode, record.passcode_hash))) {
      return res.status(401).json({ message: 'Invalid terminal ID or passcode.' });
    }

    const table = type === 'pos' ? 'pos_terminals' : 'kds_terminals';
    await pool.query(`UPDATE ${table} SET last_login_at = NOW() WHERE id = $1`, [record.id]);

    const token = jwt.sign(
      { type, id: record.id, terminal_id: record.terminal_id, branch_id: record.branch_id, name: record.name },
      jwtSecretTerminal,
      { expiresIn: jwtExpiresTerminal }
    );

    res.json({
      token,
      terminal: { type, terminal_id: record.terminal_id, branch_id: record.branch_id, name: record.name },
    });
  } catch (err) {
    console.error('Terminal login error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

module.exports = router;

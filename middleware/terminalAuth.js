const jwt  = require('jsonwebtoken');
const { jwtSecretTerminal } = require('../config');
const pool = require('../db');

const TABLE_BY_TYPE = { pos: 'pos_terminals', kds: 'kds_terminals' };

// Terminal tokens are verified against jwtSecretTerminal, a secret entirely
// separate from the dashboard's jwtSecret -- a leaked terminal token must
// never be replayable against dashboard routes, and vice versa.
//
// Re-checks is_active/deleted_at against the DB on every call (not just at
// token expiry) so deactivating a terminal in the dashboard takes effect
// immediately, not up to jwtExpiresTerminal later. Throws on any failure;
// callers (requireTerminalAuth middleware, or /kds/stream's query-param path)
// decide how to respond.
async function verifyTerminalToken(token, allowedTypes) {
  const decoded = jwt.verify(token, jwtSecretTerminal);
  if (!decoded.type || !allowedTypes.includes(decoded.type)) {
    throw new Error('WRONG_TYPE');
  }

  const table = TABLE_BY_TYPE[decoded.type];
  const result = await pool.query(
    `SELECT is_active FROM ${table} WHERE terminal_id = $1 AND deleted_at IS NULL`,
    [decoded.terminal_id]
  );
  if (!result.rowCount || !result.rows[0].is_active) {
    throw new Error('DEACTIVATED');
  }

  return {
    type: decoded.type,
    id: decoded.id,
    terminal_id: decoded.terminal_id,
    branch_id: decoded.branch_id,
    name: decoded.name,
  };
}

function requireTerminalAuth(allowedTypes) {
  return async (req, res, next) => {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Terminal not logged in.' });

    try {
      req.terminal = await verifyTerminalToken(token, allowedTypes);
      next();
    } catch (err) {
      if (err.message === 'WRONG_TYPE') return res.status(401).json({ message: 'Wrong terminal type for this endpoint.' });
      if (err.message === 'DEACTIVATED') return res.status(401).json({ message: 'This terminal has been deactivated.' });
      res.status(401).json({ message: 'Terminal session expired. Please log in again.' });
    }
  };
}

module.exports = { requireTerminalAuth, verifyTerminalToken };

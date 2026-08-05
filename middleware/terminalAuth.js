const jwt  = require('jsonwebtoken');
const { jwtSecretTerminal } = require('../config');
const pool = require('../db');

const TABLE_BY_TYPE = { pos: 'pos_terminals', kds: 'kds_terminals' };

// Terminal session tokens are verified against jwtSecretTerminal, a secret
// entirely separate from the dashboard's jwtSecret -- a leaked terminal
// session must never be replayable against dashboard routes, and vice versa.
//
// Re-checks is_active/deleted_at AND the terminal_devices row on every call
// (not just at token expiry) so deactivating a terminal, or revoking a
// single device from the dashboard, takes effect immediately -- not up to
// jwtExpiresSession later. Throws on any failure; callers (requireTerminalAuth
// middleware, or /kds/stream) decide how to respond.
async function verifySessionToken(token, allowedTypes) {
  const decoded = jwt.verify(token, jwtSecretTerminal);
  if (!decoded.type || !allowedTypes.includes(decoded.type)) {
    throw new Error('WRONG_TYPE');
  }

  const table = TABLE_BY_TYPE[decoded.type];
  // role only exists on pos_terminals -- selecting it unconditionally would
  // break kds_terminals, so only ask for it on the pos path.
  const cols = decoded.type === 'pos' ? 'is_active, role' : 'is_active';
  const result = await pool.query(
    `SELECT ${cols} FROM ${table} WHERE terminal_id = $1 AND deleted_at IS NULL`,
    [decoded.terminal_id]
  );
  if (!result.rowCount || !result.rows[0].is_active) {
    throw new Error('DEACTIVATED');
  }

  const deviceResult = await pool.query(
    `SELECT id FROM terminal_devices WHERE id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [decoded.device_id]
  );
  if (!deviceResult.rowCount) {
    throw new Error('DEVICE_REVOKED');
  }

  return {
    type: decoded.type,
    id: decoded.id,
    terminal_id: decoded.terminal_id,
    branch_id: decoded.branch_id,
    name: decoded.name,
    device_id: decoded.device_id,
    role: decoded.type === 'pos' ? result.rows[0].role : null,
  };
}

function requireTerminalAuth(allowedTypes) {
  return async (req, res, next) => {
    const token = req.cookies && req.cookies.cm_session;
    if (!token) return res.status(401).json({ message: 'Terminal not logged in.' });

    try {
      req.terminal = await verifySessionToken(token, allowedTypes);
      next();
    } catch (err) {
      if (err.message === 'WRONG_TYPE') return res.status(401).json({ message: 'Wrong terminal type for this endpoint.' });
      if (err.message === 'DEACTIVATED') return res.status(401).json({ message: 'This terminal has been deactivated.' });
      if (err.message === 'DEVICE_REVOKED') return res.status(401).json({ message: 'This device has been signed out.' });
      res.status(401).json({ message: 'Terminal session expired. Please log in again.' });
    }
  };
}

// Layer AFTER requireTerminalAuth. req.terminal.role was just re-read from
// pos_terminals this same request (see verifySessionToken above), so a role
// change made in the dashboard is enforced immediately -- never stale from
// the session JWT.
function requireTerminalRole(role) {
  return (req, res, next) => {
    if (req.terminal.role !== role) {
      return res.status(403).json({
        message: role === 'supervisor' ? 'Payment requires a supervisor terminal.' : 'This action requires a supervisor terminal.',
      });
    }
    next();
  };
}

module.exports = { requireTerminalAuth, requireTerminalRole, verifySessionToken };

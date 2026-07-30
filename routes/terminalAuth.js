const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const pool   = require('../db');
const { jwtSecretTerminal, jwtExpiresSession, deviceTokenDays, idleTimeoutMinutes, isProd } = require('../config');
const { rateLimit } = require('../middleware/rateLimit');
const { requireTerminalAuth } = require('../middleware/terminalAuth');
const { requireCsrf } = require('../middleware/terminalCsrf');

const TABLE_BY_TYPE = { pos: 'pos_terminals', kds: 'kds_terminals' };
const LOCK_THRESHOLD  = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const DEVICE_TOKEN_MS  = deviceTokenDays * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_MS = 12 * 60 * 60 * 1000;

function sha256(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// path scopes cm_device to /api so it's never sent on static-asset requests;
// cm_session covers the whole app since GET /pos and /kds themselves don't
// need it (client-side JS decides whether to show the login screen), but
// scoping it wider than /api costs nothing and keeps this simple.
function deviceCookieOpts() {
  return { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/api', maxAge: DEVICE_TOKEN_MS };
}
function sessionCookieOpts() {
  return { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/', maxAge: SESSION_COOKIE_MS };
}
function csrfCookieOpts() {
  return { httpOnly: false, secure: isProd, sameSite: 'lax', path: '/', maxAge: DEVICE_TOKEN_MS };
}

function setCsrfCookie(res) {
  res.cookie('cm_csrf', crypto.randomBytes(24).toString('hex'), csrfCookieOpts());
}

function mintSessionCookie(res, { type, id, terminal_id, branch_id, name }, deviceId) {
  const token = jwt.sign(
    { type, id, terminal_id, branch_id, name, device_id: deviceId },
    jwtSecretTerminal,
    { expiresIn: jwtExpiresSession }
  );
  res.cookie('cm_session', token, sessionCookieOpts());
}

function clearAuthCookies(res) {
  res.clearCookie('cm_device', { path: '/api' });
  res.clearCookie('cm_session', { path: '/' });
  res.clearCookie('cm_csrf', { path: '/' });
}

async function findTerminalByTerminalId(terminalId) {
  const posResult = await pool.query('SELECT * FROM pos_terminals WHERE terminal_id = $1 AND deleted_at IS NULL', [terminalId]);
  if (posResult.rowCount) return { type: 'pos', record: posResult.rows[0] };
  const kdsResult = await pool.query('SELECT * FROM kds_terminals WHERE terminal_id = $1 AND deleted_at IS NULL', [terminalId]);
  if (kdsResult.rowCount) return { type: 'kds', record: kdsResult.rows[0] };
  return { type: null, record: null };
}

// Increments failed_attempts and, at LOCK_THRESHOLD, sets locked_until and
// resets the counter (so the next attempt after the lock expires starts
// fresh instead of instantly re-locking on one bad guess).
async function registerFailedAttempt(table, record) {
  const failedAttempts = (record.failed_attempts || 0) + 1;
  if (failedAttempts >= LOCK_THRESHOLD) {
    await pool.query(
      `UPDATE ${table} SET failed_attempts = 0, locked_until = $1 WHERE id = $2`,
      [new Date(Date.now() + LOCK_DURATION_MS), record.id]
    );
    return true; // just locked
  }
  await pool.query(`UPDATE ${table} SET failed_attempts = $1 WHERE id = $2`, [failedAttempts, record.id]);
  return false;
}

// Keyed by terminal_id (not IP) -- a shop-floor tablet shares an IP with every
// other device on the same LAN, so IP-based limiting would lock out the whole
// shop after a few mistyped PINs on one unit.
const terminalLoginRateLimit = rateLimit({
  windowMs: 2 * 60 * 1000,
  max: 5,
  keyFn: req => (req.body && req.body.terminal_id) || req.ip,
});

router.post('/login', terminalLoginRateLimit, async (req, res) => {
  const { terminal_id, passcode, device_label } = req.body;
  if (!terminal_id || !passcode) {
    return res.status(400).json({ message: 'Invalid terminal ID or passcode.' });
  }

  try {
    const { type, record } = await findTerminalByTerminalId(terminal_id);
    if (!record) return res.status(401).json({ message: 'Invalid terminal ID or passcode.' });
    const table = TABLE_BY_TYPE[type];

    if (record.locked_until && new Date(record.locked_until) > new Date()) {
      return res.status(423).json({ message: 'Terminal locked, ask a manager.' });
    }

    if (!record.is_active || !(await bcrypt.compare(passcode, record.passcode_hash))) {
      const justLocked = await registerFailedAttempt(table, record);
      if (justLocked) return res.status(423).json({ message: 'Terminal locked, ask a manager.' });
      return res.status(401).json({ message: 'Invalid terminal ID or passcode.' });
    }

    await pool.query(
      `UPDATE ${table} SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1`,
      [record.id]
    );

    const rawDeviceToken = crypto.randomBytes(32).toString('hex');
    const deviceRes = await pool.query(
      `INSERT INTO terminal_devices (terminal_type, terminal_ref_id, branch_id, device_token_hash, device_label, user_agent, expires_at, last_active_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id`,
      [type, record.id, record.branch_id, sha256(rawDeviceToken), (device_label || '').trim() || null,
       req.headers['user-agent'] || null, new Date(Date.now() + DEVICE_TOKEN_MS)]
    );
    const deviceId = deviceRes.rows[0].id;

    const terminalInfo = { type, terminal_id: record.terminal_id, branch_id: record.branch_id, name: record.name };

    res.cookie('cm_device', rawDeviceToken, deviceCookieOpts());
    mintSessionCookie(res, { ...terminalInfo, id: record.id }, deviceId);
    setCsrfCookie(res);

    res.json({ terminal: terminalInfo, idle_timeout_minutes: idleTimeoutMinutes[type] });
  } catch (err) {
    console.error('Terminal login error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// Reads the device cookie, validates it, and silently re-mints a fresh
// session cookie -- this is the call that makes reboots and browser restarts
// invisible to staff. The device token itself does NOT rotate (see design
// decision: a rotating token risks a spurious lockout whenever a refresh
// response is lost on a flaky tablet connection); only its expires_at slides
// forward, and last_active_at updates for the dashboard's device list.
router.post('/session/refresh', async (req, res) => {
  const rawDeviceToken = req.cookies && req.cookies.cm_device;
  if (!rawDeviceToken) return res.status(401).json({ message: 'Not logged in.' });

  try {
    const deviceRes = await pool.query('SELECT * FROM terminal_devices WHERE device_token_hash = $1', [sha256(rawDeviceToken)]);
    if (!deviceRes.rowCount) { clearAuthCookies(res); return res.status(401).json({ message: 'Device not recognized.' }); }
    const device = deviceRes.rows[0];

    if (device.revoked_at) { clearAuthCookies(res); return res.status(401).json({ message: 'This device has been signed out.' }); }
    if (new Date(device.expires_at) <= new Date()) { clearAuthCookies(res); return res.status(401).json({ message: 'Session expired. Please log in again.' }); }

    const table = TABLE_BY_TYPE[device.terminal_type];
    const termRes = await pool.query(`SELECT * FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [device.terminal_ref_id]);
    if (!termRes.rowCount || !termRes.rows[0].is_active) { clearAuthCookies(res); return res.status(401).json({ message: 'This terminal has been deactivated.' }); }
    const record = termRes.rows[0];

    await pool.query(
      'UPDATE terminal_devices SET last_active_at = NOW(), expires_at = $1 WHERE id = $2',
      [new Date(Date.now() + DEVICE_TOKEN_MS), device.id]
    );

    const terminalInfo = { type: device.terminal_type, terminal_id: record.terminal_id, branch_id: record.branch_id, name: record.name };

    res.cookie('cm_device', rawDeviceToken, deviceCookieOpts()); // slide the browser-side expiry too
    mintSessionCookie(res, { ...terminalInfo, id: record.id }, device.id);
    setCsrfCookie(res);

    res.json({ terminal: terminalInfo, idle_timeout_minutes: idleTimeoutMinutes[device.terminal_type] });
  } catch (err) {
    console.error('Terminal refresh error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// A person check, not a device check -- dismisses the idle-lock overlay by
// re-verifying the terminal's own PIN. Does NOT touch the device token or
// terminal_devices at all.
router.post('/unlock', requireTerminalAuth(['pos', 'kds']), requireCsrf, async (req, res) => {
  const { passcode } = req.body;
  const table = TABLE_BY_TYPE[req.terminal.type];

  try {
    const termRes = await pool.query(`SELECT * FROM ${table} WHERE terminal_id = $1 AND deleted_at IS NULL`, [req.terminal.terminal_id]);
    if (!termRes.rowCount) return res.status(401).json({ message: 'Terminal not found.' });
    const record = termRes.rows[0];

    if (record.locked_until && new Date(record.locked_until) > new Date()) {
      return res.status(423).json({ message: 'Terminal locked, ask a manager.' });
    }

    if (!passcode || !(await bcrypt.compare(passcode, record.passcode_hash))) {
      const justLocked = await registerFailedAttempt(table, record);
      if (justLocked) {
        // Too many wrong PINs at the lock screen -- drop all the way back to
        // the full terminal-ID+PIN login rather than just re-showing unlock,
        // matching the login endpoint's own lockout behavior.
        res.clearCookie('cm_session', { path: '/' });
        return res.status(423).json({ message: 'Too many attempts. Terminal locked, ask a manager.' });
      }
      return res.status(401).json({ message: 'Incorrect PIN.' });
    }

    await pool.query(`UPDATE ${table} SET failed_attempts = 0 WHERE id = $1`, [record.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Terminal unlock error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// Explicit sign-out -- revokes the device outright (unlike an idle lock,
// this is deliberate: use it when reassigning a tablet to someone else).
router.post('/logout', requireCsrf, async (req, res) => {
  const rawDeviceToken = req.cookies && req.cookies.cm_device;
  try {
    if (rawDeviceToken) {
      await pool.query(
        `UPDATE terminal_devices SET revoked_at = NOW(), revoked_by = 'terminal_logout' WHERE device_token_hash = $1 AND revoked_at IS NULL`,
        [sha256(rawDeviceToken)]
      );
    }
  } catch (err) {
    console.error('Terminal logout error:', err);
  }
  clearAuthCookies(res);
  res.json({ ok: true });
});

module.exports = router;

// test/kds-cache-control.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const app = require('../app');
const pool = require('../db');
const { issueTerminalSession, cleanupTerminalDevice } = require('./helpers/terminalAuth');

let server, base, branchId, kdsId, kdsHeaders, kdsDeviceId;
const SUFFIX = Math.random().toString(36).slice(2, 8);

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-Cache-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const k = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `TK-${SUFFIX}`, 'KDS-Cache', hash]);
  kdsId = k.rows[0].id;
  const session = await issueTerminalSession(pool, { type: 'kds', id: kdsId, terminal_id: `TK-${SUFFIX}`, branch_id: branchId, name: 'x' });
  kdsHeaders = session.headers;
  kdsDeviceId = session.deviceId;
});

after(async () => {
  await cleanupTerminalDevice(pool, kdsDeviceId);
  await pool.query(`DELETE FROM kds_terminals WHERE id = $1`, [kdsId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

test('GET /kds/active sends Cache-Control: no-store', async () => {
  const res = await fetch(`${base}/api/pos/kds/active`, { headers: kdsHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('GET /kds/finished sends Cache-Control: no-store', async () => {
  const res = await fetch(`${base}/api/pos/kds/finished`, { headers: kdsHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

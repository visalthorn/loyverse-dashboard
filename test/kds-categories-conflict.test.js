// test/kds-categories-conflict.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { jwtSecret } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, kds1Id, kds2Id, categoryId;
const SUFFIX = Date.now();
const adminToken = jwt.sign({ id: 1, username: 't-admin', role: 'admin' }, jwtSecret);

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-KdsConf-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const k1 = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `T-KDS1-${SUFFIX}`, `KDS-1`, hash]);
  const k2 = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `T-KDS2-${SUFFIX}`, `KDS-2`, hash]);
  kds1Id = k1.rows[0].id;
  kds2Id = k2.rows[0].id;
  // categories.id is a uuid PK with no DB-side default in this schema (see
  // test/items.route.test.js / test/pos-orders-complete.test.js for the same
  // convention) -- must supply an explicit id rather than relying on
  // RETURNING to fill one in.
  const cat = await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2) RETURNING id`, [crypto.randomUUID(), `T-BBQ-${SUFFIX}`]);
  categoryId = cat.rows[0].id;
});

after(async () => {
  await pool.query(`DELETE FROM kds_terminal_categories WHERE kds_terminal_id IN ($1,$2)`, [kds1Id, kds2Id]);
  await pool.query(`DELETE FROM categories WHERE id = $1`, [categoryId]);
  await pool.query(`DELETE FROM kds_terminals WHERE id IN ($1,$2)`, [kds1Id, kds2Id]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

const authed = (opts = {}) => ({ ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, ...(opts.headers || {}) } });

test('assigning BBQ to KDS-1 succeeds', async () => {
  const res = await fetch(`${base}/api/kds-terminals/${kds1Id}/categories`, authed({
    method: 'PUT', body: JSON.stringify({ category_ids: [categoryId] }),
  }));
  assert.equal(res.status, 200);
});

test('assigning BBQ to KDS-2 in the same branch is rejected with 409 naming KDS-1', async () => {
  const res = await fetch(`${base}/api/kds-terminals/${kds2Id}/categories`, authed({
    method: 'PUT', body: JSON.stringify({ category_ids: [categoryId] }),
  }));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /KDS-1/);
});

test('re-saving the same set on KDS-1 itself is not a conflict', async () => {
  const res = await fetch(`${base}/api/kds-terminals/${kds1Id}/categories`, authed({
    method: 'PUT', body: JSON.stringify({ category_ids: [categoryId] }),
  }));
  assert.equal(res.status, 200);
});

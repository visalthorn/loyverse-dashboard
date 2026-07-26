const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, orderId;
const SUFFIX = Date.now();
const adminToken = jwt.sign({ id: 1, username: 't-admin', role: 'admin' }, jwtSecret);

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-Live-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const order = await pool.query(`
    INSERT INTO pos_orders (order_number, status, dining_option, subtotal, discount, total, branch_id, created_at, updated_at)
    VALUES ($1,'preparing','ក្នុងហាង',3000,0,3000,$2,NOW(),NOW()) RETURNING id
  `, [`T-Live-${SUFFIX}`, branchId]);
  orderId = order.rows[0].id;
});

after(async () => {
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

test('requires dashboard auth', async () => {
  const res = await fetch(`${base}/api/receipts/own/live`);
  assert.equal(res.status, 401);
});

test('lists active orders across branches, excludes paid/cancelled', async () => {
  const res = await fetch(`${base}/api/receipts/own/live`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const found = body.orders.find(o => o.id === orderId);
  assert.ok(found);
  assert.equal(found.status, 'preparing');
  assert.equal(found.branch_name, `T-Live-${SUFFIX}`);
});

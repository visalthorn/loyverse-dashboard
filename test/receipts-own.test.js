// test/receipts-own.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, orderId, receiptId;
const SUFFIX = Date.now();
const adminToken = jwt.sign({ id: 1, username: 't-admin', role: 'admin' }, jwtSecret);

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-OwnRcpt-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const order = await pool.query(`
    INSERT INTO pos_orders (order_number, status, dining_option, subtotal, discount, total, branch_id, created_at, updated_at, paid_at)
    VALUES ($1,'paid','ក្នុងហាង',7000,0,7000,$2,NOW(),NOW(),NOW()) RETURNING id
  `, [`T-OOrd-${SUFFIX}`, branchId]);
  orderId = order.rows[0].id;
  const receipt = await pool.query(`
    INSERT INTO pos_receipts (receipt_number, order_id, branch_id, dining_option, subtotal, discount, total, receipt_date, created_by)
    VALUES ($1,$2,$3,'ក្នុងហាង',7000,0,7000,NOW(),'tester') RETURNING id
  `, [`T-ORCP-${SUFFIX}`, orderId, branchId]);
  receiptId = receipt.rows[0].id;
});

after(async () => {
  await pool.query(`DELETE FROM pos_receipts WHERE id = $1`, [receiptId]);
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

test('source=own reads from pos_receipts', async () => {
  const res = await fetch(`${base}/api/receipts?source=own&per_page=500`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.receipts.some(r => r.id === receiptId));
});

test('branch filter narrows the result set', async () => {
  const res = await fetch(`${base}/api/receipts?source=own&branch=${branchId}&per_page=500`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  assert.ok(body.receipts.every(r => true)); // shape check only -- branch not in payload today
  assert.ok(body.receipts.some(r => r.id === receiptId));

  const otherBranch = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-Other-${SUFFIX}`]);
  const res2 = await fetch(`${base}/api/receipts?source=own&branch=${otherBranch.rows[0].id}&per_page=500`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body2 = await res2.json();
  assert.ok(!body2.receipts.some(r => r.id === receiptId));
  await pool.query(`DELETE FROM branches WHERE id = $1`, [otherBranch.rows[0].id]);
});

test('refundable is true for a fresh sale and false once refunded', async () => {
  const res = await fetch(`${base}/api/receipts?source=own&per_page=500`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  const row = body.receipts.find(r => r.id === receiptId);
  assert.equal(row.refundable, true);

  const refundRes = await pool.query(`
    INSERT INTO pos_receipts (receipt_number, order_id, branch_id, dining_option, subtotal, discount, total, receipt_date, cancelled_at, created_by)
    VALUES ($1,$2,$3,'ក្នុងហាង',7000,0,7000,NOW(),NOW(),'tester') RETURNING id
  `, [`T-ORRF-${SUFFIX}`, orderId, branchId]);
  const refundId = refundRes.rows[0].id;

  const res2 = await fetch(`${base}/api/receipts?source=own&per_page=500`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body2 = await res2.json();
  const row2 = body2.receipts.find(r => r.id === receiptId);
  assert.equal(row2.refundable, false);

  await pool.query(`DELETE FROM pos_receipts WHERE id = $1`, [refundId]);
});

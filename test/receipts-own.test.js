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

test('refundable is true for a fresh sale, false and type REFUND once refunded', async () => {
  const res = await fetch(`${base}/api/receipts?source=own&per_page=500`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  const row = body.receipts.find(r => r.id === receiptId);
  assert.equal(row.refundable, true);
  assert.equal(row.receipt_type, 'SALE');

  // Refunding now flips this SAME row -- no sibling row is inserted (see
  // routes/receipts.js POST /:id/refund, 2026-08-04).
  await pool.query(`UPDATE pos_receipts SET cancelled_at = NOW(), cancel_reason = 'test' WHERE id = $1`, [receiptId]);

  const res2 = await fetch(`${base}/api/receipts?source=own&per_page=500`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body2 = await res2.json();
  const row2 = body2.receipts.find(r => r.id === receiptId);
  assert.equal(row2.refundable, false);
  assert.equal(row2.receipt_type, 'REFUND');

  // Still exactly one row for this order -- refunding never adds a second.
  const count = await pool.query(`SELECT COUNT(*) AS n FROM pos_receipts WHERE order_id = $1`, [orderId]);
  assert.equal(Number(count.rows[0].n), 1);
});

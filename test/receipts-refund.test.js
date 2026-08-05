// test/receipts-refund.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, orderId, receiptId;
const SUFFIX = Date.now();
const adminToken = jwt.sign({ id: 1, username: 't-admin', role: 'admin' }, jwtSecret);
const viewerToken = jwt.sign({ id: 2, username: 't-viewer', role: 'viewer' }, jwtSecret);

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-Refund-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const order = await pool.query(`
    INSERT INTO pos_orders (order_number, status, dining_option, subtotal, discount, total, branch_id, created_at, updated_at, paid_at)
    VALUES ($1,'paid','ក្នុងហាង',9000,0,9000,$2,NOW(),NOW(),NOW()) RETURNING id
  `, [`T-RfOr-${SUFFIX}`, branchId]);
  orderId = order.rows[0].id;
  const receipt = await pool.query(`
    INSERT INTO pos_receipts (receipt_number, order_id, branch_id, dining_option, subtotal, discount, total, receipt_date, created_by)
    VALUES ($1,$2,$3,'ក្នុងហាង',9000,0,9000,NOW(),'tester') RETURNING id
  `, [`T-RfRc-${SUFFIX}`, orderId, branchId]);
  receiptId = receipt.rows[0].id;
  await pool.query(`
    INSERT INTO pos_receipt_items (receipt_id, item_name, quantity, price, gross_total) VALUES ($1,'Test Item',1,9000,9000)
  `, [receiptId]);
  await pool.query(`
    INSERT INTO pos_receipt_payments (receipt_id, payment_name, payment_type, money_amount, paid_at) VALUES ($1,'Cash','CASH',9000,NOW())
  `, [receiptId]);
});

after(async () => {
  await pool.query(`DELETE FROM pos_receipt_payments WHERE receipt_id = $1`, [receiptId]);
  await pool.query(`DELETE FROM pos_receipt_items WHERE receipt_id = $1`, [receiptId]);
  await pool.query(`DELETE FROM pos_receipts WHERE id = $1`, [receiptId]);
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

test('viewer cannot refund', async () => {
  const res = await fetch(`${base}/api/receipts/${receiptId}/refund`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken}` },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
});

test('admin refund marks the same row cancelled, no second row', async () => {
  const before = await pool.query(`SELECT COUNT(*) AS n FROM pos_receipts WHERE order_id = $1`, [orderId]);
  assert.equal(Number(before.rows[0].n), 1);

  const res = await fetch(`${base}/api/receipts/${receiptId}/refund`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ reason: 'Customer complaint' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.receipt_id, receiptId);

  const orig = await pool.query(`SELECT cancelled_at, cancel_reason, total FROM pos_receipts WHERE id = $1`, [receiptId]);
  assert.notEqual(orig.rows[0].cancelled_at, null);
  assert.equal(orig.rows[0].cancel_reason, 'Customer complaint');
  assert.equal(Number(orig.rows[0].total), 9000);

  const after = await pool.query(`SELECT COUNT(*) AS n FROM pos_receipts WHERE order_id = $1`, [orderId]);
  assert.equal(Number(after.rows[0].n), 1);

  // Items stayed on the original row -- nothing was copied to a new one.
  const items = await pool.query(`SELECT * FROM pos_receipt_items WHERE receipt_id = $1`, [receiptId]);
  assert.equal(items.rows.length, 1);
});

test('refunding twice is rejected', async () => {
  const res = await fetch(`${base}/api/receipts/${receiptId}/refund`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 409);
});

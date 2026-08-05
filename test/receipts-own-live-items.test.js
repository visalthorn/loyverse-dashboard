const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { jwtSecret } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, catId, itemId, orderId;
const SUFFIX = Date.now();
const adminToken = jwt.sign({ id: 1, username: 't-admin', role: 'admin' }, jwtSecret);

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-LiveIt-${SUFFIX}`]);
  branchId = b.rows[0].id;
  catId = crypto.randomUUID();
  itemId = crypto.randomUUID();
  await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2)`, [catId, `T-LiveCat-${SUFFIX}`]);
  await pool.query(`INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4)`, [itemId, `T-LiveItem-${SUFFIX}`, 6000, catId]);

  const order = await pool.query(`
    INSERT INTO pos_orders (order_number, status, dining_option, subtotal, discount, total, branch_id, created_at, updated_at)
    VALUES ($1,'preparing','ក្នុងហាង',6000,0,6000,$2,NOW(),NOW()) RETURNING id
  `, [`T-LO-${SUFFIX}`, branchId]);
  orderId = order.rows[0].id;
  await pool.query(`
    INSERT INTO pos_order_items (order_id, source_item_id, item_name, price, quantity)
    VALUES ($1,$2,'T-LiveLine',6000,1)
  `, [orderId, itemId]);
});

after(async () => {
  await pool.query(`DELETE FROM pos_order_items WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM items WHERE id = $1`, [itemId]);
  await pool.query(`DELETE FROM categories WHERE id = $1`, [catId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

test('own/live now includes each order\'s item lines', async () => {
  const res = await fetch(`${base}/api/receipts/own/live`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const found = body.orders.find(o => o.id === orderId);
  assert.ok(found);
  assert.ok(Array.isArray(found.items));
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].item_name, 'T-LiveLine');
  assert.equal(found.items[0].qty, 1);
  assert.equal(Number(found.items[0].total_price), 6000);
});

// test/pos-order-items-edit.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { jwtSecretTerminal } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, termId, catalogItemId, orderId, itemId1, itemId2;
const SUFFIX = Date.now();

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-EdIt-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const t = await pool.query(`INSERT INTO pos_terminals (name, branch_id, terminal_id, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`T-EdPos-${SUFFIX}`, branchId, `T-EdPo-${SUFFIX}`, hash]);
  termId = t.rows[0].id;
  const cat = await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2) RETURNING id`, [require('crypto').randomUUID(), `T-EdCat-${SUFFIX}`]);
  const item = await pool.query(`INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [require('crypto').randomUUID(), `T-EdItem-${SUFFIX}`, 4000, cat.rows[0].id]);
  catalogItemId = item.rows[0].id;
});

after(async () => {
  await pool.query(`DELETE FROM pos_order_events WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_order_items WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM items WHERE id = $1`, [catalogItemId]);
  await pool.query(`DELETE FROM categories WHERE name = $1`, [`T-EdCat-${SUFFIX}`]);
  await pool.query(`DELETE FROM pos_terminals WHERE id = $1`, [termId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

function posToken() {
  return jwt.sign({ type: 'pos', id: termId, terminal_id: `T-EdPo-${SUFFIX}`, branch_id: branchId, name: 'x' }, jwtSecretTerminal);
}
const authed = (opts = {}) => ({ ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${posToken()}`, ...(opts.headers || {}) } });

test('setup: create an order with two lines and send to kitchen', async () => {
  const diningRow = await pool.query(`SELECT DISTINCT dining_option FROM receipts WHERE dining_option IS NOT NULL LIMIT 1`);
  const diningOption = diningRow.rows[0]?.dining_option || 'ក្នុងហាង';
  const created = await fetch(`${base}/api/pos/orders`, authed({
    method: 'POST',
    body: JSON.stringify({ dining_option: diningOption, items: [
      { source_item_id: catalogItemId, quantity: 2 },
      { source_item_id: catalogItemId, quantity: 1 },
    ] }),
  }));
  const body = await created.json();
  orderId = body.order.id;
  itemId1 = body.order.items[0].id;
  itemId2 = body.order.items[1].id;
  assert.equal(body.order.items.length, 2);
});

test('PATCH quantity recomputes order totals', async () => {
  const res = await fetch(`${base}/api/pos/order-items/${itemId1}`, authed({ method: 'PATCH', body: JSON.stringify({ quantity: 5 }) }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const line1 = body.order.items.find(i => i.id === itemId1);
  assert.equal(line1.quantity, 5);
  assert.equal(Number(body.order.subtotal), 4000 * 5 + 4000 * 1);
});

test('a done item cannot be changed', async () => {
  await pool.query(`UPDATE pos_order_items SET kitchen_status = 'done' WHERE id = $1`, [itemId1]);
  const res = await fetch(`${base}/api/pos/order-items/${itemId1}`, authed({ method: 'PATCH', body: JSON.stringify({ quantity: 1 }) }));
  assert.equal(res.status, 409);
  await pool.query(`UPDATE pos_order_items SET kitchen_status = 'pending' WHERE id = $1`, [itemId1]);
});

test('DELETE removes a line and recomputes totals', async () => {
  const res = await fetch(`${base}/api/pos/order-items/${itemId2}`, authed({ method: 'DELETE' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.order.items.length, 1);
  assert.equal(Number(body.order.subtotal), 4000 * 5);
});

test('cannot delete the last remaining item', async () => {
  const res = await fetch(`${base}/api/pos/order-items/${itemId1}`, authed({ method: 'DELETE' }));
  assert.equal(res.status, 409);
});

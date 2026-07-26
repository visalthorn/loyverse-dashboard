const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { jwtSecretTerminal } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, kds1Id, kds2Id, catBbqId, catSeafoodId, itemBbqId, itemSeafoodId, orderId, orderItemBbqId, orderItemSeafoodId;
const SUFFIX = Date.now();

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-MSR-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const k1 = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `T-MSR1-${SUFFIX}`, 'KDS-BBQ', hash]);
  const k2 = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `T-MSR2-${SUFFIX}`, 'KDS-Seafood', hash]);
  kds1Id = k1.rows[0].id;
  kds2Id = k2.rows[0].id;

  catBbqId = crypto.randomUUID();
  catSeafoodId = crypto.randomUUID();
  await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2), ($3,$4)`,
    [catBbqId, `T-BBQ-${SUFFIX}`, catSeafoodId, `T-Seafood-${SUFFIX}`]);
  await pool.query(`INSERT INTO kds_terminal_categories (kds_terminal_id, category_id, branch_id) VALUES ($1,$2,$3)`, [kds1Id, catBbqId, branchId]);
  await pool.query(`INSERT INTO kds_terminal_categories (kds_terminal_id, category_id, branch_id) VALUES ($1,$2,$3)`, [kds2Id, catSeafoodId, branchId]);

  itemBbqId = crypto.randomUUID();
  itemSeafoodId = crypto.randomUUID();
  await pool.query(`INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4), ($5,$6,$7,$8)`,
    [itemBbqId, `T-BBQItem-${SUFFIX}`, 5000, catBbqId, itemSeafoodId, `T-SFItem-${SUFFIX}`, 8000, catSeafoodId]);

  const order = await pool.query(`
    INSERT INTO pos_orders (order_number, status, dining_option, subtotal, discount, total, branch_id, created_at, updated_at, sent_to_kitchen_at)
    VALUES ($1,'sent_to_kitchen','ក្នុងហាង',13000,0,13000,$2,NOW(),NOW(),NOW()) RETURNING id
  `, [`T-MOrd-${SUFFIX}`, branchId]);
  orderId = order.rows[0].id;

  const oi = await pool.query(`
    INSERT INTO pos_order_items (order_id, source_item_id, item_name, price, quantity, kitchen_status)
    VALUES ($1,$2,'BBQ line',5000,1,'pending'), ($1,$3,'Seafood line',8000,1,'pending')
    RETURNING id
  `, [orderId, itemBbqId, itemSeafoodId]);
  orderItemBbqId = oi.rows[0].id;
  orderItemSeafoodId = oi.rows[1].id;
});

after(async () => {
  await pool.query(`DELETE FROM pos_order_events WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_order_items WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM items WHERE id IN ($1,$2)`, [itemBbqId, itemSeafoodId]);
  await pool.query(`DELETE FROM kds_terminal_categories WHERE kds_terminal_id IN ($1,$2)`, [kds1Id, kds2Id]);
  await pool.query(`DELETE FROM categories WHERE id IN ($1,$2)`, [catBbqId, catSeafoodId]);
  await pool.query(`DELETE FROM kds_terminals WHERE id IN ($1,$2)`, [kds1Id, kds2Id]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

const kdsToken = (id, terminalId) => jwt.sign({ type: 'kds', id, terminal_id: terminalId, branch_id: branchId, name: 'x' }, jwtSecretTerminal);
const authed = (token, opts = {}) => ({ ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });

test('KDS-1 taps ready before KDS-2 finishes -- 200, fully_ready:false, order untouched', async () => {
  await fetch(`${base}/api/pos/order-items/${orderItemBbqId}/kitchen-status`, authed(kdsToken(kds1Id, `T-MSR1-${SUFFIX}`), {
    method: 'PATCH', body: JSON.stringify({ status: 'done' }),
  }));

  const res = await fetch(`${base}/api/pos/orders/${orderId}/ready`, authed(kdsToken(kds1Id, `T-MSR1-${SUFFIX}`), { method: 'POST' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.fully_ready, false);
  assert.equal(body.order.status, 'preparing');
});

test('KDS-1 cannot be blocked by KDS-2 still-pending items -- no 409', async () => {
  const orderRow = await pool.query('SELECT status FROM pos_orders WHERE id = $1', [orderId]);
  assert.notEqual(orderRow.rows[0].status, 'ready');
});

test('KDS-2 tapping ready before its own item is done still 409s (real error, not the multi-station bug)', async () => {
  const res = await fetch(`${base}/api/pos/orders/${orderId}/ready`, authed(kdsToken(kds2Id, `T-MSR2-${SUFFIX}`), { method: 'POST' }));
  assert.equal(res.status, 409);
});

test('the last item struck anywhere auto-advances the order to ready, no explicit ready tap needed', async () => {
  const res = await fetch(`${base}/api/pos/order-items/${orderItemSeafoodId}/kitchen-status`, authed(kdsToken(kds2Id, `T-MSR2-${SUFFIX}`), {
    method: 'PATCH', body: JSON.stringify({ status: 'done' }),
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.order.status, 'ready');
});

test('un-striking an item back to pending still works freely (no lock introduced)', async () => {
  const res = await fetch(`${base}/api/pos/order-items/${orderItemBbqId}/kitchen-status`, authed(kdsToken(kds1Id, `T-MSR1-${SUFFIX}`), {
    method: 'PATCH', body: JSON.stringify({ status: 'pending' }),
  }));
  assert.equal(res.status, 200);
  const item = await pool.query('SELECT kitchen_status FROM pos_order_items WHERE id = $1', [orderItemBbqId]);
  assert.equal(item.rows[0].kitchen_status, 'pending');
});

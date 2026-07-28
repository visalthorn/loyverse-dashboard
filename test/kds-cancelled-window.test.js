// test/kds-cancelled-window.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { jwtSecretTerminal } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, kdsDbId, kdsTerminalId, catId, itemId, oldOrderId, freshOrderId;
const SUFFIX = Date.now();

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`BC${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const k = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `TC${SUFFIX}`, 'T', hash]);
  kdsDbId = k.rows[0].id;
  kdsTerminalId = `TC${SUFFIX}`;

  catId = crypto.randomUUID();
  await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2)`, [catId, `CC${SUFFIX}`]);
  await pool.query(`INSERT INTO kds_terminal_categories (kds_terminal_id, category_id, branch_id) VALUES ($1,$2,$3)`, [kdsDbId, catId, branchId]);
  itemId = crypto.randomUUID();
  await pool.query(`INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4)`, [itemId, `IC${SUFFIX}`, 4000, catId]);

  // Cancelled 30 hours ago -- must be excluded by the 24h window.
  const oldOrder = await pool.query(`
    INSERT INTO pos_orders (order_number, status, dining_option, subtotal, discount, total, branch_id, created_at, updated_at, cancelled_at, cancel_reason)
    VALUES ($1,'cancelled','ក្នុងហាង',4000,0,4000,$2, NOW() - INTERVAL '31 hours', NOW() - INTERVAL '30 hours', NOW() - INTERVAL '30 hours', 'too old')
    RETURNING id
  `, [`OC1${SUFFIX}`, branchId]);
  oldOrderId = oldOrder.rows[0].id;
  await pool.query(`INSERT INTO pos_order_items (order_id, source_item_id, item_name, price, quantity, kitchen_status) VALUES ($1,$2,$3,4000,1,'pending')`,
    [oldOrderId, itemId, `IC${SUFFIX}`]);

  // Cancelled 1 hour ago -- must be included.
  const freshOrder = await pool.query(`
    INSERT INTO pos_orders (order_number, status, dining_option, subtotal, discount, total, branch_id, created_at, updated_at, cancelled_at, cancel_reason)
    VALUES ($1,'cancelled','ក្នុងហាង',4000,0,4000,$2, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour', 'customer left')
    RETURNING id
  `, [`OC2${SUFFIX}`, branchId]);
  freshOrderId = freshOrder.rows[0].id;
  await pool.query(`INSERT INTO pos_order_items (order_id, source_item_id, item_name, price, quantity, kitchen_status) VALUES ($1,$2,$3,4000,1,'pending')`,
    [freshOrderId, itemId, `IC${SUFFIX}`]);
});

after(async () => {
  await pool.query(`DELETE FROM pos_order_items WHERE order_id IN ($1,$2)`, [oldOrderId, freshOrderId]);
  await pool.query(`DELETE FROM pos_orders WHERE id IN ($1,$2)`, [oldOrderId, freshOrderId]);
  await pool.query(`DELETE FROM items WHERE id = $1`, [itemId]);
  await pool.query(`DELETE FROM kds_terminal_categories WHERE kds_terminal_id = $1`, [kdsDbId]);
  await pool.query(`DELETE FROM categories WHERE id = $1`, [catId]);
  await pool.query(`DELETE FROM kds_terminals WHERE id = $1`, [kdsDbId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

test('cancelled list includes orders cancelled within 24h, excludes older ones, and carries cancel_reason', async () => {
  const token = jwt.sign({ type: 'kds', id: kdsDbId, terminal_id: kdsTerminalId, branch_id: branchId, name: 'x' }, jwtSecretTerminal);
  const res = await fetch(`${base}/api/pos/kds/cancelled`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.orders.map(o => o.id);
  assert.ok(ids.includes(freshOrderId), 'order cancelled 1h ago should be in the list');
  assert.ok(!ids.includes(oldOrderId), 'order cancelled 31h ago should NOT be in the list');
  const fresh = body.orders.find(o => o.id === freshOrderId);
  assert.equal(fresh.cancel_reason, 'customer left');
});

test('/kds/cancelled respects branch scoping', async () => {
  const otherBranch = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`BC-Other-${SUFFIX}`]);
  const otherBranchId = otherBranch.rows[0].id;
  const otherOrder = await pool.query(`
    INSERT INTO pos_orders (order_number, status, dining_option, subtotal, discount, total, branch_id, created_at, updated_at, cancelled_at)
    VALUES ($1,'cancelled','ក្នុងហាង',4000,0,4000,$2, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour')
    RETURNING id
  `, [`OC3${SUFFIX}`, otherBranchId]);
  const otherOrderId = otherOrder.rows[0].id;
  await pool.query(`INSERT INTO pos_order_items (order_id, source_item_id, item_name, price, quantity, kitchen_status) VALUES ($1,$2,$3,4000,1,'pending')`,
    [otherOrderId, itemId, `IC${SUFFIX}`]);

  try {
    const token = jwt.sign({ type: 'kds', id: kdsDbId, terminal_id: kdsTerminalId, branch_id: branchId, name: 'x' }, jwtSecretTerminal);
    const res = await fetch(`${base}/api/pos/kds/cancelled`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    assert.ok(!body.orders.map(o => o.id).includes(otherOrderId));
  } finally {
    await pool.query(`DELETE FROM pos_order_items WHERE order_id = $1`, [otherOrderId]);
    await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [otherOrderId]);
    await pool.query(`DELETE FROM branches WHERE id = $1`, [otherBranchId]);
  }
});

test('/kds/cancelled returns no_categories_assigned:true for a terminal with no category mapping', async () => {
  const hash = await bcrypt.hash('000000', 10);
  const k2 = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `TC2${SUFFIX}`, 'T2', hash]);
  const kds2Id = k2.rows[0].id;

  try {
    const token = jwt.sign({ type: 'kds', id: kds2Id, terminal_id: `TC2${SUFFIX}`, branch_id: branchId, name: 'x' }, jwtSecretTerminal);
    const res = await fetch(`${base}/api/pos/kds/cancelled`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    assert.deepEqual(body.orders, []);
    assert.equal(body.no_categories_assigned, true);
  } finally {
    await pool.query(`DELETE FROM kds_terminals WHERE id = $1`, [kds2Id]);
  }
});

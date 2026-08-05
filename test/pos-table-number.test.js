// test/pos-table-number.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const app = require('../app');
const pool = require('../db');
const { issueTerminalSession, cleanupTerminalDevice } = require('./helpers/terminalAuth');

const DINE_IN = 'ក្នុងហាង';

let server, base, branchId, posDbId, posTerminalId, catalogItemId, posHeaders, posDeviceId;
const SUFFIX = Date.now();
const createdOrderIds = [];

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-Table-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const posTerm = await pool.query(`INSERT INTO pos_terminals (name, branch_id, terminal_id, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`T-Tbl-${SUFFIX}`, branchId, `T-Tbl-${SUFFIX}`, hash]);
  posDbId = posTerm.rows[0].id;
  posTerminalId = `T-Tbl-${SUFFIX}`;
  const session = await issueTerminalSession(pool, { type: 'pos', id: posDbId, terminal_id: posTerminalId, branch_id: branchId, name: posTerminalId });
  posHeaders = session.headers;
  posDeviceId = session.deviceId;
  const cat = await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2) RETURNING id`, [crypto.randomUUID(), `T-TblCat-${SUFFIX}`]);
  const item = await pool.query(`INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [crypto.randomUUID(), `T-TblItem-${SUFFIX}`, 3000, cat.rows[0].id]);
  catalogItemId = item.rows[0].id;
});

after(async () => {
  if (createdOrderIds.length) {
    await pool.query(`DELETE FROM pos_order_events WHERE order_id = ANY($1)`, [createdOrderIds]);
    await pool.query(`DELETE FROM pos_order_items WHERE order_id = ANY($1)`, [createdOrderIds]);
    await pool.query(`DELETE FROM pos_orders WHERE id = ANY($1)`, [createdOrderIds]);
  }
  await pool.query(`DELETE FROM items WHERE id = $1`, [catalogItemId]);
  await pool.query(`DELETE FROM categories WHERE name = $1`, [`T-TblCat-${SUFFIX}`]);
  await cleanupTerminalDevice(pool, posDeviceId);
  await pool.query(`DELETE FROM pos_terminals WHERE id = $1`, [posDbId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

async function createOrder(body) {
  const res = await fetch(`${base}/api/pos/orders`, {
    method: 'POST', headers: posHeaders,
    body: JSON.stringify({ items: [{ source_item_id: catalogItemId, quantity: 1 }], ...body }),
  });
  const data = await res.json();
  if (data.order) createdOrderIds.push(data.order.id);
  return { status: res.status, data };
}

test('creating a dine-in order without a table number is rejected', async () => {
  const { status, data } = await createOrder({ dining_option: DINE_IN, table_number: '' });
  assert.equal(status, 400);
  assert.match(data.message, /table_number is required for dine-in/);
});

test('creating a dine-in order with a table number succeeds', async () => {
  const { status, data } = await createOrder({ dining_option: DINE_IN, table_number: `T1-${SUFFIX}` });
  assert.equal(status, 201);
  assert.equal(data.order.table_number, `T1-${SUFFIX}`);
});

test('a second active order cannot claim the same table number in the same branch', async () => {
  const table = `T2-${SUFFIX}`;
  const first = await createOrder({ dining_option: DINE_IN, table_number: table });
  assert.equal(first.status, 201);

  const second = await createOrder({ dining_option: DINE_IN, table_number: table });
  assert.equal(second.status, 409);
  assert.match(second.data.message, /already has an active order/);
});

test('a table number frees up once the order holding it is cancelled', async () => {
  const table = `T3-${SUFFIX}`;
  const first = await createOrder({ dining_option: DINE_IN, table_number: table });
  assert.equal(first.status, 201);

  const cancelRes = await fetch(`${base}/api/pos/orders/${first.data.order.id}/cancel`, {
    method: 'POST', headers: posHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(cancelRes.status, 200);

  const second = await createOrder({ dining_option: DINE_IN, table_number: table });
  assert.equal(second.status, 201);
});

test('non-dine-in orders do not require a table number', async () => {
  const { status, data } = await createOrder({ dining_option: 'ដឹកជញ្ចូន' });
  assert.equal(status, 201);
  assert.equal(data.order.table_number, null);
});

test('PATCH table-number persists on an already-saved order', async () => {
  const created = await createOrder({ dining_option: 'ដឹកជញ្ចូន' }); // starts with no table number
  assert.equal(created.status, 201);
  const orderId = created.data.order.id;

  const patchRes = await fetch(`${base}/api/pos/orders/${orderId}/table-number`, {
    method: 'PATCH', headers: posHeaders,
    body: JSON.stringify({ table_number: `T4-${SUFFIX}` }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.order.table_number, `T4-${SUFFIX}`);

  const getRes = await fetch(`${base}/api/pos/orders/${orderId}`, { headers: posHeaders });
  const fetched = await getRes.json();
  assert.equal(fetched.order.table_number, `T4-${SUFFIX}`, 'table number must survive a fresh GET, not just the PATCH response');
});

test('PATCH table-number to a value already active on another order is rejected', async () => {
  const table = `T5-${SUFFIX}`;
  const holder = await createOrder({ dining_option: DINE_IN, table_number: table });
  assert.equal(holder.status, 201);

  const other = await createOrder({ dining_option: 'ដឹកជញ្ចូន' });
  assert.equal(other.status, 201);

  const patchRes = await fetch(`${base}/api/pos/orders/${other.data.order.id}/table-number`, {
    method: 'PATCH', headers: posHeaders,
    body: JSON.stringify({ table_number: table }),
  });
  assert.equal(patchRes.status, 409);
});

test('PATCH table-number lets an order keep its own table number unchanged', async () => {
  const table = `T6-${SUFFIX}`;
  const created = await createOrder({ dining_option: DINE_IN, table_number: table });
  assert.equal(created.status, 201);

  const patchRes = await fetch(`${base}/api/pos/orders/${created.data.order.id}/table-number`, {
    method: 'PATCH', headers: posHeaders,
    body: JSON.stringify({ table_number: table }),
  });
  assert.equal(patchRes.status, 200, 'setting a dine-in order\'s table number to its own current value must not 409 against itself');
});

test('PATCH table-number to blank on a dine-in order is rejected', async () => {
  const created = await createOrder({ dining_option: DINE_IN, table_number: `T7-${SUFFIX}` });
  assert.equal(created.status, 201);

  const patchRes = await fetch(`${base}/api/pos/orders/${created.data.order.id}/table-number`, {
    method: 'PATCH', headers: posHeaders,
    body: JSON.stringify({ table_number: '' }),
  });
  assert.equal(patchRes.status, 400);
});

test('switching an order to dine-in without a table number set is rejected', async () => {
  const created = await createOrder({ dining_option: 'ដឹកជញ្ចូន' }); // no table number
  assert.equal(created.status, 201);

  const patchRes = await fetch(`${base}/api/pos/orders/${created.data.order.id}/dining-option`, {
    method: 'PATCH', headers: posHeaders,
    body: JSON.stringify({ dining_option: DINE_IN }),
  });
  assert.equal(patchRes.status, 400);
});

test('switching an order to dine-in succeeds once a table number is set', async () => {
  const created = await createOrder({ dining_option: 'ដឹកជញ្ចូន' });
  assert.equal(created.status, 201);
  const orderId = created.data.order.id;

  await fetch(`${base}/api/pos/orders/${orderId}/table-number`, {
    method: 'PATCH', headers: posHeaders,
    body: JSON.stringify({ table_number: `T8-${SUFFIX}` }),
  });

  const patchRes = await fetch(`${base}/api/pos/orders/${orderId}/dining-option`, {
    method: 'PATCH', headers: posHeaders,
    body: JSON.stringify({ dining_option: DINE_IN }),
  });
  assert.equal(patchRes.status, 200);
});

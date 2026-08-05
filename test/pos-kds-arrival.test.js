// test/pos-kds-arrival.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const app = require('../app');
const pool = require('../db');
const { issueTerminalSession, cleanupTerminalDevice } = require('./helpers/terminalAuth');

let server, base, branchId, terminalDbId, terminalId, catalogItemId, orderId, posHeaders, posDeviceId;
const SUFFIX = Date.now();

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-Arrival-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const term = await pool.query(`INSERT INTO pos_terminals (name, branch_id, terminal_id, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`T-Arro-${SUFFIX}`, branchId, `T-Arro-${SUFFIX}`, hash]);
  terminalDbId = term.rows[0].id;
  terminalId = `T-Arro-${SUFFIX}`;
  const session = await issueTerminalSession(pool, { type: 'pos', id: terminalDbId, terminal_id: terminalId, branch_id: branchId, name: terminalId });
  posHeaders = session.headers;
  posDeviceId = session.deviceId;
  const cat = await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2) RETURNING id`, [crypto.randomUUID(), `T-ArrCat-${SUFFIX}`]);
  const item = await pool.query(`INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [crypto.randomUUID(), `T-ArrItem-${SUFFIX}`, 4000, cat.rows[0].id]);
  catalogItemId = item.rows[0].id;
});

after(async () => {
  await pool.query(`DELETE FROM pos_order_events WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_order_items WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM items WHERE id = $1`, [catalogItemId]);
  await pool.query(`DELETE FROM categories WHERE name = $1`, [`T-ArrCat-${SUFFIX}`]);
  await cleanupTerminalDevice(pool, posDeviceId);
  await pool.query(`DELETE FROM pos_terminals WHERE id = $1`, [terminalDbId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

test('column exists', async () => {
  const col = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'pos_orders' AND column_name = 'sent_to_kitchen_at'
  `);
  assert.equal(col.rows.length, 1);
});

test('send-to-kitchen sets sent_to_kitchen_at', async () => {
  const diningRow = await pool.query(`SELECT DISTINCT dining_option FROM receipts WHERE dining_option IS NOT NULL LIMIT 1`);
  const diningOption = diningRow.rows[0]?.dining_option || 'ក្នុងហាង';

  const created = await fetch(`${base}/api/pos/orders`, {
    method: 'POST', headers: posHeaders,
    body: JSON.stringify({ dining_option: diningOption, table_number: `T${SUFFIX}`, items: [{ source_item_id: catalogItemId, quantity: 1 }] }),
  });
  const order = (await created.json()).order;
  orderId = order.id;
  assert.equal(order.sent_to_kitchen_at, null);

  // Call send-to-kitchen endpoint
  const sentRes = await fetch(`${base}/api/pos/orders/${orderId}/send-to-kitchen`, {
    method: 'POST', headers: posHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(sentRes.status, 200);
  const sentOrder = (await sentRes.json()).order;

  // Check that send-to-kitchen sets sent_to_kitchen_at
  const row = await pool.query(`SELECT sent_to_kitchen_at, status FROM pos_orders WHERE id = $1`, [orderId]);
  assert.equal(row.rows[0].status, 'sent_to_kitchen');
  assert.notEqual(row.rows[0].sent_to_kitchen_at, null, 'sent_to_kitchen_at should be set when order is sent to kitchen');
});

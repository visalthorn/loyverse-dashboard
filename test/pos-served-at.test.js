// test/pos-served-at.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const app = require('../app');
const pool = require('../db');
const { issueTerminalSession, cleanupTerminalDevice } = require('./helpers/terminalAuth');

let server, base, branchId, posTerminalDbId, kdsTerminalDbId, terminalId, catalogItemId, orderId, posHeaders, kdsHeaders, posDeviceId, kdsDeviceId;
const SUFFIX = Date.now();

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-Served-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const posTerm = await pool.query(`INSERT INTO pos_terminals (name, branch_id, terminal_id, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`T-Srv-${SUFFIX}`, branchId, `T-Srv-${SUFFIX}`, hash]);
  posTerminalDbId = posTerm.rows[0].id;
  const kdsTerm = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `T-Srv-${SUFFIX}`, `T-Srv-${SUFFIX}`, hash]);
  kdsTerminalDbId = kdsTerm.rows[0].id;
  terminalId = `T-Srv-${SUFFIX}`;
  const posSession = await issueTerminalSession(pool, { type: 'pos', id: posTerminalDbId, terminal_id: terminalId, branch_id: branchId, name: terminalId });
  const kdsSession = await issueTerminalSession(pool, { type: 'kds', id: kdsTerminalDbId, terminal_id: terminalId, branch_id: branchId, name: terminalId });
  posHeaders = posSession.headers;
  kdsHeaders = kdsSession.headers;
  posDeviceId = posSession.deviceId;
  kdsDeviceId = kdsSession.deviceId;
  const cat = await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2) RETURNING id`, [crypto.randomUUID(), `T-SrvCat-${SUFFIX}`]);
  const catId = cat.rows[0].id;
  const item = await pool.query(`INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [crypto.randomUUID(), `T-SrvItem-${SUFFIX}`, 3000, catId]);
  catalogItemId = item.rows[0].id;
  // Map the category to the KDS terminal so it can mark items as done
  await pool.query(`INSERT INTO kds_terminal_categories (kds_terminal_id, category_id, branch_id) VALUES ($1,$2,$3)`, [kdsTerminalDbId, catId, branchId]);
});

after(async () => {
  await pool.query(`DELETE FROM pos_order_events WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_order_items WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM items WHERE id = $1`, [catalogItemId]);
  const catRes = await pool.query(`SELECT id FROM categories WHERE name = $1`, [`T-SrvCat-${SUFFIX}`]);
  if (catRes.rows.length) {
    await pool.query(`DELETE FROM kds_terminal_categories WHERE category_id = $1`, [catRes.rows[0].id]);
  }
  await pool.query(`DELETE FROM categories WHERE name = $1`, [`T-SrvCat-${SUFFIX}`]);
  await cleanupTerminalDevice(pool, posDeviceId);
  await cleanupTerminalDevice(pool, kdsDeviceId);
  await pool.query(`DELETE FROM pos_terminals WHERE id = $1`, [posTerminalDbId]);
  await pool.query(`DELETE FROM kds_terminals WHERE id = $1`, [kdsTerminalDbId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

test('column exists', async () => {
  const col = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'pos_orders' AND column_name = 'served_at'
  `);
  assert.equal(col.rows.length, 1);
});

test('marking an order served sets served_at', async () => {
  const diningRow = await pool.query(`SELECT DISTINCT dining_option FROM receipts WHERE dining_option IS NOT NULL LIMIT 1`);
  const diningOption = diningRow.rows[0]?.dining_option || 'ក្នុងហាង';

  const created = await fetch(`${base}/api/pos/orders`, {
    method: 'POST', headers: posHeaders,
    body: JSON.stringify({ dining_option: diningOption, table_number: `T${SUFFIX}`, items: [{ source_item_id: catalogItemId, quantity: 1 }] }),
  });
  orderId = (await created.json()).order.id;

  await fetch(`${base}/api/pos/orders/${orderId}/send-to-kitchen`, {
    method: 'POST', headers: posHeaders, body: JSON.stringify({}),
  });

  // Get the order item id so we can mark it as done
  const itemRes = await pool.query(`SELECT id FROM pos_order_items WHERE order_id = $1`, [orderId]);
  const itemId = itemRes.rows[0].id;

  // Mark the item as done to auto-transition order to ready
  await fetch(`${base}/api/pos/order-items/${itemId}/kitchen-status`, {
    method: 'PATCH', headers: kdsHeaders,
    body: JSON.stringify({ status: 'done' }),
  });

  const preRow = await pool.query(`SELECT served_at FROM pos_orders WHERE id = $1`, [orderId]);
  assert.equal(preRow.rows[0].served_at, null);

  const servedRes = await fetch(`${base}/api/pos/orders/${orderId}/served`, {
    method: 'POST', headers: kdsHeaders, body: JSON.stringify({}),
  });
  assert.equal(servedRes.status, 200);

  const postRow = await pool.query(`SELECT status, served_at FROM pos_orders WHERE id = $1`, [orderId]);
  assert.equal(postRow.rows[0].status, 'served');
  assert.notEqual(postRow.rows[0].served_at, null, 'served_at should be set when order is marked served');

  // Close the loop: the served_at value the app just wrote via its real
  // POST /served -> toCambodiaTime() path must actually flow through the
  // /kds/finished 24h-window query and come back out, not just exist as a
  // raw column value. This is what test/kds-finished-window.test.js (which
  // seeds served_at with raw NOW() - INTERVAL SQL) cannot catch.
  const finishedRes = await fetch(`${base}/api/pos/kds/finished`, { headers: kdsHeaders });
  assert.equal(finishedRes.status, 200);
  const finishedBody = await finishedRes.json();
  const finishedIds = finishedBody.orders.map(o => o.id);
  assert.ok(finishedIds.includes(orderId), 'order just marked served should appear in /kds/finished');
});

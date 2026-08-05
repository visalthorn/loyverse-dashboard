const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const app = require('../app');
const pool = require('../db');
const { issueTerminalSession, cleanupTerminalDevice } = require('./helpers/terminalAuth');

let server, base, branchId, terminalId, terminalDbId, catalogItemId, orderId, posHeaders, posDeviceId;
const SUFFIX = Date.now();

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const branch = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-Complete-${SUFFIX}`]);
  branchId = branch.rows[0].id;

  const hash = await bcrypt.hash('000000', 10);
  // role: 'supervisor' -- POST /orders/:id/pay and /complete require a
  // supervisor terminal (see requireTerminalRole in routes/pos.js); this file
  // is testing the pay/complete flow itself, not role gating (see
  // pos-order-lock.test.js for that), so it needs a terminal allowed to pay.
  const term = await pool.query(`
    INSERT INTO pos_terminals (name, branch_id, terminal_id, passcode_hash, role) VALUES ($1,$2,$3,$4,'supervisor') RETURNING id
  `, [`T-POS-${SUFFIX}`, branchId, `T-POS-${SUFFIX}`, hash]);
  terminalDbId = term.rows[0].id;
  terminalId = `T-POS-${SUFFIX}`;
  const session = await issueTerminalSession(pool, { type: 'pos', id: terminalDbId, terminal_id: terminalId, branch_id: branchId, name: terminalId });
  posHeaders = session.headers;
  posDeviceId = session.deviceId;

  // categories.id / items.id are uuid PKs with no DB-side default in this
  // schema (see test/items.route.test.js for the same convention) -- must
  // supply explicit ids ourselves rather than relying on RETURNING to fill one in.
  const cat = await pool.query(
    `INSERT INTO categories (id, name) VALUES ($1,$2) RETURNING id`,
    [crypto.randomUUID(), `T-Cat-${SUFFIX}`]
  );
  const item = await pool.query(`
    INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4) RETURNING id
  `, [crypto.randomUUID(), `T-Item-${SUFFIX}`, 5000, cat.rows[0].id]);
  catalogItemId = item.rows[0].id;
});

after(async () => {
  await pool.query(`DELETE FROM pos_receipt_payments WHERE receipt_id IN (SELECT id FROM pos_receipts WHERE branch_id = $1)`, [branchId]);
  await pool.query(`DELETE FROM pos_receipt_items WHERE receipt_id IN (SELECT id FROM pos_receipts WHERE branch_id = $1)`, [branchId]);
  await pool.query(`UPDATE pos_orders SET receipt_id = NULL WHERE branch_id = $1`, [branchId]);
  await pool.query(`DELETE FROM pos_receipts WHERE branch_id = $1`, [branchId]);
  await pool.query(`DELETE FROM pos_order_events WHERE order_id IN (SELECT id FROM pos_orders WHERE branch_id = $1)`, [branchId]);
  await pool.query(`DELETE FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE branch_id = $1)`, [branchId]);
  await pool.query(`DELETE FROM pos_orders WHERE branch_id = $1`, [branchId]);
  await pool.query(`DELETE FROM items WHERE id = $1`, [catalogItemId]);
  await pool.query(`DELETE FROM categories WHERE name = $1`, [`T-Cat-${SUFFIX}`]);
  await cleanupTerminalDevice(pool, posDeviceId);
  await pool.query(`DELETE FROM pos_terminals WHERE id = $1`, [terminalDbId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

test('creating an order works (setup for completion tests)', async () => {
  const diningRow = await pool.query(`SELECT DISTINCT dining_option FROM receipts WHERE dining_option IS NOT NULL LIMIT 1`);
  const diningOption = diningRow.rows[0]?.dining_option || 'ក្នុងហាង';
  const res = await fetch(`${base}/api/pos/orders`, {
    method: 'POST',
    headers: posHeaders,
    body: JSON.stringify({ dining_option: diningOption, table_number: `1`, items: [{ source_item_id: catalogItemId, quantity: 2 }] }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  orderId = body.order.id;
  assert.equal(body.order.status, 'open');
});

test('POST /complete pays the order AND writes an immutable receipt', async () => {
  const res = await fetch(`${base}/api/pos/orders/${orderId}/complete`, {
    method: 'POST',
    headers: posHeaders,
    body: JSON.stringify({ payment_method: 'cash', cash_received: 20000 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.order.status, 'paid');
  assert.ok(body.receipt_number);
  assert.equal(body.order.receipt_id !== null, true);
  assert.equal(body.change, 10000);

  const receipt = await pool.query(`SELECT * FROM pos_receipts WHERE id = $1`, [body.order.receipt_id]);
  assert.equal(receipt.rows.length, 1);
  assert.equal(receipt.rows[0].receipt_number, body.receipt_number);
  assert.equal(Number(receipt.rows[0].total), 10000);
  assert.equal(receipt.rows[0].branch_id, branchId);
  assert.equal(receipt.rows[0].cancelled_at, null);

  const items = await pool.query(`SELECT * FROM pos_receipt_items WHERE receipt_id = $1`, [body.order.receipt_id]);
  assert.equal(items.rows.length, 1);
  assert.equal(items.rows[0].quantity, 2);

  const payments = await pool.query(`SELECT * FROM pos_receipt_payments WHERE receipt_id = $1`, [body.order.receipt_id]);
  assert.equal(payments.rows.length, 1);
  assert.equal(payments.rows[0].payment_name, 'Cash');
});

test('/pay still works as an alias', async () => {
  const diningRow = await pool.query(`SELECT DISTINCT dining_option FROM receipts WHERE dining_option IS NOT NULL LIMIT 1`);
  const diningOption = diningRow.rows[0]?.dining_option || 'ក្នុងហាង';
  const created = await fetch(`${base}/api/pos/orders`, {
    method: 'POST',
    headers: posHeaders,
    body: JSON.stringify({ dining_option: diningOption, table_number: `2`, items: [{ source_item_id: catalogItemId, quantity: 1 }] }),
  });
  const order2 = (await created.json()).order;

  const res = await fetch(`${base}/api/pos/orders/${order2.id}/pay`, {
    method: 'POST',
    headers: posHeaders,
    body: JSON.stringify({ payment_method: 'khqr' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.order.status, 'paid');
  assert.ok(body.receipt_number);
});

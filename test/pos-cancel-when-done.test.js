const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const app = require('../app');
const pool = require('../db');
const { issueTerminalSession, cleanupTerminalDevice } = require('./helpers/terminalAuth');

let server, base, branchId, termId, catalogItemId, orderId, itemId, posHeaders, posDeviceId;
const SUFFIX = Date.now();

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-CnLk-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const t = await pool.query(`INSERT INTO pos_terminals (name, branch_id, terminal_id, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`T-CnPos-${SUFFIX}`, branchId, `T-CnPo-${SUFFIX}`, hash]);
  termId = t.rows[0].id;
  const session = await issueTerminalSession(pool, { type: 'pos', id: termId, terminal_id: `T-CnPo-${SUFFIX}`, branch_id: branchId, name: 'x' });
  posHeaders = session.headers;
  posDeviceId = session.deviceId;
  const cat = await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2) RETURNING id`, [crypto.randomUUID(), `T-CnCat-${SUFFIX}`]);
  const item = await pool.query(`INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [crypto.randomUUID(), `T-CnItem-${SUFFIX}`, 4000, cat.rows[0].id]);
  catalogItemId = item.rows[0].id;
});

after(async () => {
  await pool.query(`DELETE FROM pos_order_events WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_order_items WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM items WHERE id = $1`, [catalogItemId]);
  await pool.query(`DELETE FROM categories WHERE name = $1`, [`T-CnCat-${SUFFIX}`]);
  await cleanupTerminalDevice(pool, posDeviceId);
  await pool.query(`DELETE FROM pos_terminals WHERE id = $1`, [termId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

const authed = (opts = {}) => ({ ...opts, headers: { ...posHeaders, ...(opts.headers || {}) } });

test('setup: create an order with one line', async () => {
  const created = await fetch(`${base}/api/pos/orders`, authed({
    method: 'POST',
    body: JSON.stringify({ dining_option: 'ក្នុងហាង', table_number: `T${SUFFIX}`, items: [{ source_item_id: catalogItemId, quantity: 1 }] }),
  }));
  const body = await created.json();
  orderId = body.order.id;
  itemId = body.order.items[0].id;
  assert.equal(body.order.items.length, 1);
});

// Deliberately no kitchen_status gate on order-level cancel either (POS
// revision, 2026-08-02, see the comment above router.post('/orders/:id/cancel')
// in routes/pos.js): any order/supervisor terminal may cancel any open order
// regardless of item prep state. Accountability is the pos_order_events audit
// row, not an access restriction.
test('cancel succeeds even once the item is done, and is recorded in the audit log', async () => {
  await pool.query(`UPDATE pos_order_items SET kitchen_status = 'done' WHERE id = $1`, [itemId]);
  const res = await fetch(`${base}/api/pos/orders/${orderId}/cancel`, authed({ method: 'POST', body: JSON.stringify({ reason: 'customer left' }) }));
  assert.equal(res.status, 200);

  const order = await pool.query(`SELECT status FROM pos_orders WHERE id = $1`, [orderId]);
  assert.equal(order.rows[0].status, 'cancelled');

  const event = await pool.query(
    `SELECT detail FROM pos_order_events WHERE order_id = $1 AND event = 'cancelled' ORDER BY id DESC LIMIT 1`, [orderId]
  );
  assert.equal(event.rows.length, 1);
  assert.equal(event.rows[0].detail.reason, 'customer left');
});

test('cancelling an already-cancelled order is rejected', async () => {
  const res = await fetch(`${base}/api/pos/orders/${orderId}/cancel`, authed({ method: 'POST', body: JSON.stringify({}) }));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'ORDER_TERMINAL');
});

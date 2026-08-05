// test/pos-order-items-edit.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const app = require('../app');
const pool = require('../db');
const { issueTerminalSession, cleanupTerminalDevice } = require('./helpers/terminalAuth');

let server, base, branchId, termId, catalogItemId, orderId, itemId1, itemId2, posHeaders, posDeviceId;
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
  const session = await issueTerminalSession(pool, { type: 'pos', id: termId, terminal_id: `T-EdPo-${SUFFIX}`, branch_id: branchId, name: 'x' });
  posHeaders = session.headers;
  posDeviceId = session.deviceId;
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
  await cleanupTerminalDevice(pool, posDeviceId);
  await pool.query(`DELETE FROM pos_terminals WHERE id = $1`, [termId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

const authed = (opts = {}) => ({ ...opts, headers: { ...posHeaders, ...(opts.headers || {}) } });
function cancelItem(itemId, body = {}) {
  return fetch(`${base}/api/pos/orders/${orderId}/items/${itemId}/cancel`, authed({ method: 'POST', body: JSON.stringify(body) }));
}

test('setup: create an order with two lines and send to kitchen', async () => {
  const diningRow = await pool.query(`SELECT DISTINCT dining_option FROM receipts WHERE dining_option IS NOT NULL LIMIT 1`);
  const diningOption = diningRow.rows[0]?.dining_option || 'ក្នុងហាង';
  const created = await fetch(`${base}/api/pos/orders`, authed({
    method: 'POST',
    body: JSON.stringify({ dining_option: diningOption, table_number: `T${SUFFIX}`, items: [
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

// The old PATCH quantity / DELETE line routes were replaced by this single
// cancel endpoint (POS revision, 2026-08-02, see routes/pos.js) -- qty is how
// much to remove, not the resulting quantity.
test('cancelling part of a line (qty < quantity) reduces it and recomputes totals', async () => {
  const res = await cancelItem(itemId1, { qty: 1 }); // item1 starts at qty 2
  assert.equal(res.status, 200);
  const body = await res.json();
  const line1 = body.order.items.find(i => i.id === itemId1);
  assert.equal(line1.quantity, 1);
  assert.equal(Number(body.order.subtotal), 4000 * 1 + 4000 * 1);
});

// Deliberately no kitchen_status gate (see the route's own comment): cancelling
// a line already 'done' must succeed -- that's the specific rule this endpoint
// exists to guarantee, unlike the old PATCH/DELETE routes it replaced.
test('cancelling an item already marked done still succeeds (no kitchen_status gate, by design)', async () => {
  await pool.query(`UPDATE pos_order_items SET kitchen_status = 'done' WHERE id = $1`, [itemId1]);
  const res = await cancelItem(itemId1); // qty omitted = remove the whole remaining line
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.order.items.length, 1);
  assert.equal(Number(body.order.subtotal), 4000 * 1);
});

test('cannot cancel the last remaining item -- must cancel the order instead', async () => {
  const res = await cancelItem(itemId2);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.message, /cancel the order instead/i);
});

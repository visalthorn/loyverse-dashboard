const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { jwtSecretTerminal } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, posId, kdsId, catId, itemId, orderId;
const SUFFIX = Date.now();

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-TZ-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const pos = await pool.query(`INSERT INTO pos_terminals (name, branch_id, terminal_id, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`T-TZPos-${SUFFIX}`, branchId, `T-TZPo-${SUFFIX}`, hash]);
  posId = pos.rows[0].id;
  const kds = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `T-TZKd-${SUFFIX}`, 'KDS-TZ', hash]);
  kdsId = kds.rows[0].id;
  catId = crypto.randomUUID();
  await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2)`, [catId, `T-TZCat-${SUFFIX}`]);
  await pool.query(`INSERT INTO kds_terminal_categories (kds_terminal_id, category_id, branch_id) VALUES ($1,$2,$3)`, [kdsId, catId, branchId]);
  itemId = crypto.randomUUID();
  await pool.query(`INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4)`, [itemId, `T-TZItem-${SUFFIX}`, 3000, catId]);
});

after(async () => {
  await pool.query(`DELETE FROM pos_order_events WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_order_items WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM items WHERE id = $1`, [itemId]);
  await pool.query(`DELETE FROM kds_terminal_categories WHERE kds_terminal_id = $1`, [kdsId]);
  await pool.query(`DELETE FROM categories WHERE id = $1`, [catId]);
  await pool.query(`DELETE FROM kds_terminals WHERE id = $1`, [kdsId]);
  await pool.query(`DELETE FROM pos_terminals WHERE id = $1`, [posId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

const posToken = () => jwt.sign({ type: 'pos', id: posId, terminal_id: `T-TZPo-${SUFFIX}`, branch_id: branchId, name: 'x' }, jwtSecretTerminal);
const kdsToken = () => jwt.sign({ type: 'kds', id: kdsId, terminal_id: `T-TZKd-${SUFFIX}`, branch_id: branchId, name: 'x' }, jwtSecretTerminal);
const authed = (token, opts = {}) => ({ ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });

test('setup: create and send an order to the kitchen', async () => {
  const created = await fetch(`${base}/api/pos/orders`, authed(posToken(), {
    method: 'POST',
    body: JSON.stringify({ dining_option: 'ក្នុងហាង', table_number: `T${SUFFIX}`, items: [{ source_item_id: itemId, quantity: 1 }] }),
  }));
  const body = await created.json();
  orderId = body.order.id;
  const sent = await fetch(`${base}/api/pos/orders/${orderId}/send-to-kitchen`, authed(posToken(), { method: 'POST', body: '{}' }));
  assert.equal(sent.status, 200);
});

test('server_now and sent_to_kitchen_at agree to within a few seconds (no 7-hour residual)', async () => {
  const res = await fetch(`${base}/api/pos/kds/active`, { headers: { Authorization: `Bearer ${kdsToken()}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const order = body.orders.find(o => o.id === orderId);
  assert.ok(order, 'order should appear on the KDS board');

  const serverNowMs = Date.parse(body.server_now);
  const sentMs      = Date.parse(order.sent_to_kitchen_at);
  assert.ok(!Number.isNaN(serverNowMs), 'server_now must be a parseable real timestamp');
  assert.ok(!Number.isNaN(sentMs), 'sent_to_kitchen_at must be a parseable real timestamp');

  // The Date.parse comparison below only discriminates the historical bug by
  // coincidence on machines whose local timezone happens to match Cambodia's
  // +7 offset (e.g. this box, Asia/Bangkok) -- Date.parse resolves a naive
  // "YYYY-MM-DD HH:mm:ss" string using the LOCAL timezone, same as pg does
  // for the TIMESTAMP column, so both sides can cancel identically even
  // without the fix. Assert the actual wire format directly so a future
  // reversion to toCambodiaTime(new Date()) (which never ends in "Z") is
  // caught regardless of which machine/timezone runs this test.
  assert.match(body.server_now, /Z$/, 'server_now must be a real UTC ISO string ending in "Z", not a naive Cambodia-local string');

  // Before the fix this gap was ~25,200,000ms (7 hours); a fresh order
  // should show effectively zero elapsed time.
  assert.ok(Math.abs(serverNowMs - sentMs) < 5000,
    `expected server_now and sent_to_kitchen_at within 5s, got ${serverNowMs - sentMs}ms`);
  assert.ok(Math.abs(serverNowMs - Date.now()) < 5000);
});

test('warn_minutes/danger_minutes are present and sane on both boards', async () => {
  for (const path of ['active', 'finished']) {
    const res = await fetch(`${base}/api/pos/kds/${path}`, { headers: { Authorization: `Bearer ${kdsToken()}` } });
    const body = await res.json();
    assert.ok(Number.isInteger(body.warn_minutes) && body.warn_minutes > 0);
    assert.ok(Number.isInteger(body.danger_minutes) && body.danger_minutes > body.warn_minutes);
  }
});

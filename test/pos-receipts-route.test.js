// test/pos-receipts-route.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const app = require('../app');
const pool = require('../db');
const { issueTerminalSession, cleanupTerminalDevice } = require('./helpers/terminalAuth');

let server, base, branchAId, branchBId, termAId, termBId, receiptId, headersA, headersB, deviceAId, deviceBId;
const SUFFIX = Date.now();

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const ba = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-RcptA-${SUFFIX}`]);
  const bb = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-RcptB-${SUFFIX}`]);
  branchAId = ba.rows[0].id;
  branchBId = bb.rows[0].id;

  const hash = await bcrypt.hash('000000', 10);
  const ta = await pool.query(`INSERT INTO pos_terminals (name, branch_id, terminal_id, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`T-PosA-${SUFFIX}`, branchAId, `T-PosA-${SUFFIX}`, hash]);
  const tb = await pool.query(`INSERT INTO pos_terminals (name, branch_id, terminal_id, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`T-PosB-${SUFFIX}`, branchBId, `T-PosB-${SUFFIX}`, hash]);
  termAId = ta.rows[0].id;
  termBId = tb.rows[0].id;

  const sessionA = await issueTerminalSession(pool, { type: 'pos', id: termAId, terminal_id: `T-PosA-${SUFFIX}`, branch_id: branchAId, name: `T-PosA-${SUFFIX}` });
  const sessionB = await issueTerminalSession(pool, { type: 'pos', id: termBId, terminal_id: `T-PosB-${SUFFIX}`, branch_id: branchBId, name: `T-PosB-${SUFFIX}` });
  headersA = sessionA.headers;
  headersB = sessionB.headers;
  deviceAId = sessionA.deviceId;
  deviceBId = sessionB.deviceId;

  const order = await pool.query(`
    INSERT INTO pos_orders (order_number, status, dining_option, subtotal, discount, total, branch_id, terminal_id, created_at, updated_at, paid_at)
    VALUES ($1,'paid','ក្នុងហាង',5000,0,5000,$2,$3,NOW(),NOW(),NOW()) RETURNING id
  `, [`T-ORD-${SUFFIX}`, branchAId, termAId]);
  const receipt = await pool.query(`
    INSERT INTO pos_receipts (receipt_number, order_id, branch_id, pos_terminal_id, dining_option, subtotal, discount, total, receipt_date, created_by)
    VALUES ($1,$2,$3,$4,'ក្នុងហាង',5000,0,5000,NOW(),$5) RETURNING id
  `, [`T-RCPT-${SUFFIX}`, order.rows[0].id, branchAId, termAId, `T-PosA-${SUFFIX}`]);
  receiptId = receipt.rows[0].id;
});

after(async () => {
  await pool.query(`DELETE FROM pos_receipts WHERE id = $1`, [receiptId]);
  await pool.query(`DELETE FROM pos_orders WHERE order_number = $1`, [`T-ORD-${SUFFIX}`]);
  await cleanupTerminalDevice(pool, deviceAId);
  await cleanupTerminalDevice(pool, deviceBId);
  await pool.query(`DELETE FROM pos_terminals WHERE id IN ($1,$2)`, [termAId, termBId]);
  await pool.query(`DELETE FROM branches WHERE id IN ($1,$2)`, [branchAId, branchBId]);
  server.close();
  await pool.end();
});

// The route buckets by Cambodia date (routes/pos.js: DATE(r.receipt_date) =
// (NOW() AT TIME ZONE 'Asia/Phnom_Penh')::date), so the fixture has to ask for
// the Cambodia day too. toISOString() yields the UTC day, which is a different
// date every evening between 17:00 and 24:00 UTC — the test passed all morning
// and failed after 17:00.
const cambodiaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });

test('same-branch terminal sees the receipt in the list', async () => {
  const res = await fetch(`${base}/api/pos/receipts?date=${cambodiaToday()}`, { headers: headersA });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.receipts.some(r => r.id === receiptId));
});

test('same-branch terminal can fetch the detail with items', async () => {
  const res = await fetch(`${base}/api/pos/receipts/${receiptId}`, { headers: headersA });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.receipt.id, receiptId);
  assert.ok(Array.isArray(body.receipt.items));
});

test('a different branch terminal cannot see it', async () => {
  const list = await fetch(`${base}/api/pos/receipts`, { headers: headersB });
  const listBody = await list.json();
  assert.ok(!listBody.receipts.some(r => r.id === receiptId));

  const detail = await fetch(`${base}/api/pos/receipts/${receiptId}`, { headers: headersB });
  assert.equal(detail.status, 404);
});

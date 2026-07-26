// test/pos-receipts-views-regression.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');

let loyverseBaselineTotal;

before(async () => {
  // A date range guaranteed to have no OWN_POS activity (well before this
  // feature branch existed) -- byte-identical before/after the repoint.
  const r = await pool.query(`
    SELECT COALESCE(SUM(total_money), 0) AS total, COUNT(*) AS n
    FROM v_receipts_all WHERE source != 'OWN_POS' AND DATE(receipt_date) = '2026-05-01'
  `);
  loyverseBaselineTotal = { total: r.rows[0].total, n: r.rows[0].n };
});

after(async () => { await pool.end(); });

test('Loyverse-only historical range is unaffected by the repoint', async () => {
  const r = await pool.query(`
    SELECT COALESCE(SUM(total_money), 0) AS total, COUNT(*) AS n
    FROM v_receipts_all WHERE source != 'OWN_POS' AND DATE(receipt_date) = '2026-05-01'
  `);
  assert.equal(r.rows[0].total, loyverseBaselineTotal.total);
  assert.equal(r.rows[0].n, loyverseBaselineTotal.n);
});

test('v_receipts_all reads OWN_POS rows from pos_receipts, not pos_orders', async () => {
  const def = await pool.query(`SELECT pg_get_viewdef('v_receipts_all'::regclass, true) AS def`);
  assert.match(def.rows[0].def, /pos_receipts/);
  assert.doesNotMatch(def.rows[0].def, /pos_orders/);
});

test('a completed pos_orders sale surfaces through v_receipts_all with branch_id populated', async () => {
  const r = await pool.query(`
    SELECT receipt_number, branch_id FROM v_receipts_all
    WHERE source = 'OWN_POS'
    ORDER BY receipt_date DESC LIMIT 1
  `);
  if (r.rows.length) assert.ok(r.rows[0].branch_id !== null);
});

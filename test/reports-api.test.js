const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');
const app = require('../app');
const pool = require('../db');
const { rebuildSummaries } = require('../services/sync');

let server, base;
const adminToken  = jwt.sign({ id: 1, username: 't-admin',  role: 'admin'  }, jwtSecret);
const viewerToken = jwt.sign({ id: 2, username: 't-viewer', role: 'viewer' }, jwtSecret);

// Real UAT data spans 2026-04-13 → 2026-05-11; use a ten-day slice.
const START = '2026-04-13';
const END   = '2026-04-22';
const RANGE = `start=${START}&end=${END}`;

const get = (path, token = viewerToken) =>
  fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Cover current + previous window so growth numbers are comparable too.
  await rebuildSummaries('2026-04-03', END, 'test');
});

after(async () => {
  server.close();
  await pool.end();
});

test('summary endpoint requires auth', async () => {
  const res = await fetch(`${base}/api/reports/summary?${RANGE}`);
  assert.equal(res.status, 401);
});

test('summary rejects bad ranges', async () => {
  const res = await fetch(`${base}/api/reports/summary?start=${END}&end=${START}`,
    { headers: { Authorization: `Bearer ${viewerToken}` } });
  assert.equal(res.status, 400);
});

test('summary parity with /api/kpis', async () => {
  const [n, o] = await Promise.all([
    get(`/api/reports/summary?${RANGE}`),
    get(`/api/kpis?period=range&${RANGE}`),
  ]);
  assert.equal(n.gross_income.value, o.gross_income.value);
  assert.equal(n.orders.value, o.orders.value);
  assert.equal(n.aov.value, o.aov.value);
  assert.equal(n.expenses.value, o.expenses.value);
  assert.equal(n.net_revenue, o.net_revenue);
  assert.equal(n.avg_gross_income.value, o.avg_gross_income.value);
  assert.equal(n.avg_expense.value, o.avg_expense.value);
  assert.equal(n.net_per_order.value, o.net_per_order.value);
  assert.equal(n.gross_income.growth, o.gross_income.growth);
});

test('trend parity with /api/gross-income', async () => {
  const [n, o] = await Promise.all([
    get(`/api/reports/trend?${RANGE}`),
    get(`/api/gross-income?period=range&${RANGE}`),
  ]);
  assert.equal(n.length, o.length);
  const key = d => new Date(d).toISOString().slice(0, 10);
  n.forEach((row, i) => {
    assert.equal(key(row.period), key(o[i].period));
    assert.equal(parseFloat(row.gross_income), parseFloat(o[i].gross_income));
  });
});

test('dining parity with /api/dining-options', async () => {
  const [n, o] = await Promise.all([
    get(`/api/reports/dining?${RANGE}`),
    get(`/api/dining-options?period=range&${RANGE}`),
  ]);
  assert.deepEqual(
    n.map(r => [r.dining_option, parseInt(r.orders), parseFloat(r.revenue)]),
    o.map(r => [r.dining_option, parseInt(r.orders), parseFloat(r.revenue)]),
  );
});

test('payments parity with /api/payment-methods', async () => {
  const [n, o] = await Promise.all([
    get(`/api/reports/payments?${RANGE}`),
    get(`/api/payment-methods?period=range&${RANGE}`),
  ]);
  assert.deepEqual(
    n.map(r => [r.payment_name, parseInt(r.transactions), parseFloat(r.total)]),
    o.map(r => [r.payment_name, parseInt(r.transactions), parseFloat(r.total)]),
  );
});

test('top-items parity with /api/item-comparison', async () => {
  const [n, o] = await Promise.all([
    get(`/api/reports/top-items?${RANGE}&limit=5`),
    get(`/api/item-comparison?period=range&${RANGE}&order=desc&limit=5`),
  ]);
  assert.equal(n.length, o.length);
  n.forEach((row, i) => {
    assert.equal(row.sku, o[i].sku);
    assert.equal(parseFloat(row.revenue), parseFloat(o[i].revenue));
    assert.equal(parseInt(row.qty), parseInt(o[i].qty));
  });
});

test('device parity with /api/device-performance', async () => {
  const [n, o] = await Promise.all([
    get(`/api/reports/device?${RANGE}`),
    get(`/api/device-performance?period=range&${RANGE}`),
  ]);
  assert.deepEqual(
    n.map(r => [r.device_name, parseInt(r.orders), parseFloat(r.revenue)]),
    o.map(r => [r.device_name, parseInt(r.orders), parseFloat(r.revenue)]),
  );
});

test('coverage returns min/max day', async () => {
  const c = await get('/api/reports/coverage');
  assert.ok(c.min_day);
  assert.ok(c.max_day);
});

test('summary includes items_sold matching daily_item_summary', async () => {
  const s = await get(`/api/reports/summary?${RANGE}`);
  assert.ok(s.items_sold, 'items_sold missing from summary');
  const direct = await pool.query(
    `SELECT COALESCE(SUM(qty), 0) AS n FROM daily_item_summary WHERE day BETWEEN $1 AND $2`,
    [START, END]);
  assert.equal(parseInt(s.items_sold.value), parseInt(direct.rows[0].n));
  assert.ok(parseInt(s.items_sold.value) > 0, 'expected non-zero items sold in UAT range');
  assert.ok('growth' in s.items_sold);
});

test('summary includes net_growth for the KPI tile', async () => {
  const s = await get(`/api/reports/summary?${RANGE}`);
  assert.ok('net_growth' in s, 'net_growth missing from summary');
  assert.equal(typeof s.net_growth, 'number');
});

test('highlights includes categorySplit by units', async () => {
  const h = await get(`/api/reports/highlights?${RANGE}`);
  assert.ok(Array.isArray(h.categorySplit), 'categorySplit missing');
  assert.ok(h.categorySplit.length > 0, 'expected categories in UAT range');
  assert.ok(h.categorySplit.length <= 5, 'top 4 + Other max');
  h.categorySplit.forEach(c => {
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.units, 'number');
    assert.equal(typeof c.pct, 'number');
  });
  const units = h.categorySplit.reduce((s, c) => s + c.units, 0);
  assert.equal(units, h.totals.itemsSold, 'category units must sum to itemsSold');
  const pctSum = h.categorySplit.reduce((s, c) => s + c.pct, 0);
  assert.ok(Math.abs(pctSum - 100) < 0.01, `pct must sum to 100, got ${pctSum}`);
  // Ordered by units desc (Other bucket, if present, is always last).
  const named = h.categorySplit.filter(c => c.label !== 'Other');
  for (let i = 1; i < named.length; i++) assert.ok(named[i - 1].units >= named[i].units);
});

test('highlights channelSplit/paymentSplit include revenue amounts', async () => {
  const h = await get(`/api/reports/highlights?${RANGE}`);
  assert.ok(h.channelSplit.length > 0, 'expected channel split rows in UAT range');
  h.channelSplit.forEach(p => { assert.equal(typeof p.revenue, 'number'); assert.ok(p.revenue >= 0); });
  const chTotal = h.channelSplit.reduce((s, p) => s + p.revenue, 0);
  h.channelSplit.forEach(p => {
    const expectedPct = Math.round((p.revenue / chTotal) * 1000) / 10;
    assert.ok(Math.abs(p.pct - expectedPct) < 1.5, `channel pct ${p.pct} should roughly match revenue share ${expectedPct}`);
  });

  assert.ok(h.paymentSplit.length > 0, 'expected payment split rows in UAT range');
  h.paymentSplit.forEach(p => { assert.equal(typeof p.revenue, 'number'); assert.ok(p.revenue >= 0); });
});

test('rebuild is admin-only', async () => {
  const res = await fetch(`${base}/api/reports/rebuild`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${viewerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: START, end: END }),
  });
  assert.equal(res.status, 403);
  const ok = await fetch(`${base}/api/reports/rebuild`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: START, end: END }),
  });
  assert.equal(ok.status, 200);
});

test('top-items-by-report-category groups items by report category', async () => {
  const day = '2026-04-15';
  await pool.query(`INSERT INTO item_categories (sku, category, report_category)
    VALUES ('RC-TOP-1', 'Some Cat', 'RC Group A')
    ON CONFLICT (sku) DO UPDATE SET report_category = EXCLUDED.report_category`);
  await pool.query(`INSERT INTO daily_item_summary (day, sku, item_name, qty, revenue)
    VALUES ($1, 'RC-TOP-1', 'RC Top Item', 3, 90000)
    ON CONFLICT (day, sku) DO UPDATE SET qty = EXCLUDED.qty, revenue = EXCLUDED.revenue`, [day]);

  try {
    const rows = await get(`/api/reports/top-items-by-report-category?start=${day}&end=${day}`);
    const group = rows.find(g => g.report_category === 'RC Group A');
    assert.ok(group, 'expected RC Group A in response');
    const item = group.items.find(i => i.sku === 'RC-TOP-1');
    assert.ok(item, 'expected RC-TOP-1 in the group');
    assert.equal(item.qty, 3);
    assert.equal(item.revenue, 90000);
  } finally {
    await pool.query(`DELETE FROM daily_item_summary WHERE sku = 'RC-TOP-1'`);
    await pool.query(`DELETE FROM item_categories WHERE sku = 'RC-TOP-1'`);
  }
});

test('top-items-by-report-category omits groups with no report category', async () => {
  const rows = await get(`/api/reports/top-items-by-report-category?${RANGE}`);
  assert.ok(Array.isArray(rows));
  rows.forEach(g => assert.ok(g.report_category, 'every group must have a non-empty report_category'));
});

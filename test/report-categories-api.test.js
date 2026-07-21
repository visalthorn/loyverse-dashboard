const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');
const app = require('../app');
const pool = require('../db');

const CAT_A  = '00000000-0000-4000-8000-0000000000ba';
const ITEM_1 = '00000000-0000-4000-8000-0000000000b1';

let server, base;
let reportCategoryId;
const adminToken  = jwt.sign({ id: 1, username: 't-admin',  role: 'admin'  }, jwtSecret);
const viewerToken = jwt.sign({ id: 2, username: 't-viewer', role: 'viewer' }, jwtSecret);

async function cleanup() {
  await pool.query('DELETE FROM items WHERE id = $1', [ITEM_1]);
  await pool.query('DELETE FROM categories WHERE id = $1', [CAT_A]);
  await pool.query("DELETE FROM item_categories WHERE sku = 'RC-SKU-1'");
  await pool.query("DELETE FROM report_categories WHERE name IN ('RC Test','RC Test Renamed')");
}

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await cleanup();
  await pool.query(`INSERT INTO categories (id, name, color) VALUES ($1,'RC Cat','GREY')`, [CAT_A]);
  await pool.query(`INSERT INTO items (id, sku, name, category_id, price) VALUES ($1,'RC-SKU-1','RC Item',$2, 3000)`, [ITEM_1, CAT_A]);
});

after(async () => {
  await cleanup();
  server.close();
  await pool.end();
});

const authed = (token, extra = {}) =>
  ({ headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...extra });

test('POST /api/items/report-categories is blocked for viewers', async () => {
  const res = await fetch(`${base}/api/items/report-categories`,
    authed(viewerToken, { method: 'POST', body: JSON.stringify({ name: 'RC Test' }) }));
  assert.equal(res.status, 403);
});

test('POST /api/items/report-categories creates a category', async () => {
  const res = await fetch(`${base}/api/items/report-categories`,
    authed(adminToken, { method: 'POST', body: JSON.stringify({ name: 'RC Test' }) }));
  assert.equal(res.status, 201);
  const row = await res.json();
  assert.equal(row.name, 'RC Test');
  reportCategoryId = row.id;
});

test('POST duplicate name returns 409', async () => {
  const res = await fetch(`${base}/api/items/report-categories`,
    authed(adminToken, { method: 'POST', body: JSON.stringify({ name: 'RC Test' }) }));
  assert.equal(res.status, 409);
});

test('GET /api/items/report-categories lists it', async () => {
  const res = await fetch(`${base}/api/items/report-categories`, authed(viewerToken));
  const rows = await res.json();
  assert.ok(rows.find(r => r.id === reportCategoryId && r.name === 'RC Test'));
});

test('PUT /api/items/:id assigns report_category_id and rebuilds item_categories', async () => {
  const res = await fetch(`${base}/api/items/${ITEM_1}`,
    authed(adminToken, { method: 'PUT', body: JSON.stringify({ report_category_id: reportCategoryId }) }));
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.report_category_id, reportCategoryId);
  assert.equal(row.report_category_name, 'RC Test');

  const ic = await pool.query("SELECT report_category FROM item_categories WHERE sku='RC-SKU-1'");
  assert.equal(ic.rows[0].report_category, 'RC Test');
});

test('PUT /api/items/report-categories/:id renames and rebuild reflects it', async () => {
  const res = await fetch(`${base}/api/items/report-categories/${reportCategoryId}`,
    authed(adminToken, { method: 'PUT', body: JSON.stringify({ name: 'RC Test Renamed' }) }));
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.name, 'RC Test Renamed');

  const ic = await pool.query("SELECT report_category FROM item_categories WHERE sku='RC-SKU-1'");
  assert.equal(ic.rows[0].report_category, 'RC Test Renamed');
});

test('PUT /api/items/report-categories/:id with non-numeric id returns 404', async () => {
  const res = await fetch(`${base}/api/items/report-categories/abc`,
    authed(adminToken, { method: 'PUT', body: JSON.stringify({ name: 'RC Test Whatever' }) }));
  assert.equal(res.status, 404);
});

test('PUT /api/items/report-categories/:id with unknown numeric id returns 404', async () => {
  const res = await fetch(`${base}/api/items/report-categories/999999`,
    authed(adminToken, { method: 'PUT', body: JSON.stringify({ name: 'RC Test Whatever' }) }));
  assert.equal(res.status, 404);
});

test('DELETE /api/items/report-categories/:id clears assignment via ON DELETE SET NULL', async () => {
  const res = await fetch(`${base}/api/items/report-categories/${reportCategoryId}`,
    authed(adminToken, { method: 'DELETE' }));
  assert.equal(res.status, 200);

  const item = await pool.query('SELECT report_category_id FROM items WHERE id = $1', [ITEM_1]);
  assert.equal(item.rows[0].report_category_id, null);

  const ic = await pool.query("SELECT report_category FROM item_categories WHERE sku='RC-SKU-1'");
  assert.equal(ic.rows[0].report_category, null);
});

test('DELETE /api/items/report-categories/:id with unknown id returns 404', async () => {
  const res = await fetch(`${base}/api/items/report-categories/999999`,
    authed(adminToken, { method: 'DELETE' }));
  assert.equal(res.status, 404);
});

test('DELETE /api/items/report-categories/:id with non-numeric id returns 404', async () => {
  const res = await fetch(`${base}/api/items/report-categories/abc`,
    authed(adminToken, { method: 'DELETE' }));
  assert.equal(res.status, 404);
});

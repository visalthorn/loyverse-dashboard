const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const { upsertCatalog, rebuildItemCategories } = require('../services/sync/items');

const CAT_A  = '00000000-0000-4000-8000-00000000000a';
const CAT_B  = '00000000-0000-4000-8000-00000000000b';
const ITEM_1 = '00000000-0000-4000-8000-000000000001';

const category = (id, name) => ({ id, name, color: 'GREY', deleted_at: null });
const item = (id, name, categoryId, sku, price) => ({
  id, item_name: name, category_id: categoryId, image_url: null, deleted_at: null,
  variants: [{ sku, default_price: price, cost: 1000 }],
});

async function cleanup() {
  await pool.query('DELETE FROM items WHERE id IN ($1)', [ITEM_1]);
  await pool.query('DELETE FROM categories WHERE id IN ($1,$2)', [CAT_A, CAT_B]);
  await pool.query("DELETE FROM item_categories WHERE sku = 'TEST-SKU-1'");
  await pool.query("DELETE FROM sync_logs WHERE sync_type = 'items' AND triggered_by = 'test'");
}

before(cleanup);
after(async () => { await cleanup(); await pool.end(); });

test('first sync inserts categories, items, and rebuilds item_categories', async () => {
  const result = await upsertCatalog({
    categories: [category(CAT_A, 'BBQ'), category(CAT_B, 'Drink')],
    items: [item(ITEM_1, 'Beef Skewer', CAT_A, 'TEST-SKU-1', 20000)],
  }, 'test');

  assert.equal(result.status, 'success');
  assert.equal(result.inserted, 1);

  const it = await pool.query('SELECT * FROM items WHERE id=$1', [ITEM_1]);
  assert.equal(it.rows[0].name, 'Beef Skewer');
  assert.equal(it.rows[0].sku, 'TEST-SKU-1');
  assert.equal(it.rows[0].category_id, CAT_A);

  const ic = await pool.query("SELECT category FROM item_categories WHERE sku='TEST-SKU-1'");
  assert.equal(ic.rows[0].category, 'BBQ');
});

test('re-sync preserves custom overrides and applies them to item_categories', async () => {
  await pool.query('UPDATE items SET custom_name=$1, custom_category_id=$2 WHERE id=$3',
    ['My Beef', CAT_B, ITEM_1]);
  await pool.query("UPDATE categories SET custom_name='Drinks & More' WHERE id=$1", [CAT_B]);

  const result = await upsertCatalog({
    categories: [category(CAT_A, 'BBQ'), category(CAT_B, 'Drink')],
    items: [item(ITEM_1, 'Beef Skewer RENAMED', CAT_A, 'TEST-SKU-1', 22000)],
  }, 'test');
  assert.equal(result.status, 'success');

  const it = await pool.query('SELECT * FROM items WHERE id=$1', [ITEM_1]);
  assert.equal(it.rows[0].name, 'Beef Skewer RENAMED');   // Loyverse column updated
  assert.equal(it.rows[0].custom_name, 'My Beef');        // override untouched
  assert.equal(it.rows[0].custom_category_id, CAT_B);     // override untouched
  assert.equal(Number(it.rows[0].price), 22000);

  // item_categories reflects the OVERRIDDEN category with its custom name
  const ic = await pool.query("SELECT category FROM item_categories WHERE sku='TEST-SKU-1'");
  assert.equal(ic.rows[0].category, 'Drinks & More');
});

test('items missing from the payload are soft-deleted and leave item_categories', async () => {
  const result = await upsertCatalog({
    categories: [category(CAT_A, 'BBQ'), category(CAT_B, 'Drink')],
    items: [item('00000000-0000-4000-8000-000000000009', 'Other', CAT_A, 'TEST-SKU-9', 1)],
  }, 'test');
  assert.equal(result.status, 'success');

  const it = await pool.query('SELECT deleted_at FROM items WHERE id=$1', [ITEM_1]);
  assert.ok(it.rows[0].deleted_at !== null);

  const ic = await pool.query("SELECT 1 FROM item_categories WHERE sku='TEST-SKU-1'");
  assert.equal(ic.rows.length, 0);

  // cleanup the extra fixture
  await pool.query("DELETE FROM items WHERE id='00000000-0000-4000-8000-000000000009'");
  await pool.query("DELETE FROM item_categories WHERE sku='TEST-SKU-9'");
});

test('empty items payload is skipped, nothing marked deleted', async () => {
  const result = await upsertCatalog({ categories: [], items: [] }, 'test');
  assert.equal(result.status, 'skipped');
});

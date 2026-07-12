const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
const pool   = require('../../db');
const { fetchItems, fetchCategories } = require('../loyverse');
const { writeSyncLog } = require('./log');
const { tz } = require('../../config');

dayjs.extend(utc);
dayjs.extend(tzPlug);

// Rebuild the legacy sku -> category-name mapping used by routes/analytics.js.
// Accepts a client so it can join an open transaction; defaults to the pool.
//
// NOTE: a naive `WITH del AS (DELETE FROM item_categories) INSERT INTO item_categories ...`
// is NOT safe here — per the Postgres docs, sibling data-modifying CTEs "cannot see one
// another's effects" and execute in unpredictable order, so the DELETE is not guaranteed
// to precede the INSERT's uniqueness check. Verified this deterministically raises
// "duplicate key value violates unique constraint item_categories_pkey" on every rebuild
// after the first (i.e. any time a sku being reinserted already exists). Instead we
// compute the new mapping once, delete only the rows that are now stale (sku no longer
// present), and upsert the rest via ON CONFLICT — atomic, race-free, and never empties
// the table for readers.
async function rebuildItemCategories(db = pool) {
  await db.query(`
    WITH new_data AS (
      SELECT DISTINCT ON (i.sku) i.sku, COALESCE(c.custom_name, c.name) AS category
      FROM items i
      JOIN categories c ON c.id = COALESCE(i.custom_category_id, i.category_id)
      WHERE i.sku IS NOT NULL AND i.deleted_at IS NULL
      ORDER BY i.sku
    ),
    del AS (
      DELETE FROM item_categories
      WHERE sku NOT IN (SELECT sku FROM new_data)
    )
    INSERT INTO item_categories (sku, category)
    SELECT sku, category FROM new_data
    ON CONFLICT (sku) DO UPDATE SET category = EXCLUDED.category
  `);
}

// Applies a fetched catalog to the DB. Writes ONLY Loyverse-owned columns —
// custom_name / custom_category_id are never touched, so local edits survive.
async function upsertCatalog({ categories, items }, triggeredBy = 'manual') {
  const syncDate = dayjs().tz(tz).format('YYYY-MM-DD');

  if (!items.length || !categories.length) {
    console.log('⚠️  [items-sync] Empty items or categories from Loyverse — skipping');
    await writeSyncLog({ syncType: 'items', syncDate, status: 'skipped', triggeredBy, inserted: 0 });
    return { status: 'skipped', inserted: 0 };
  }

  const catIds = new Set(categories.map(c => c.id));
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const c of categories) {
      await client.query(`
        INSERT INTO categories (id, name, color, deleted_at, synced_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (id) DO UPDATE
          SET name = $2, color = $3, deleted_at = $4, synced_at = NOW(), updated_at = NOW()
      `, [c.id, c.name, c.color || null, c.deleted_at || null]);
    }
    await client.query(`
      UPDATE categories SET deleted_at = NOW(), updated_at = NOW()
      WHERE deleted_at IS NULL AND NOT (id = ANY($1::uuid[]))
    `, [categories.map(c => c.id)]);

    let inserted = 0;
    for (const it of items) {
      const v = (it.variants && it.variants[0]) || {};
      const categoryId = catIds.has(it.category_id) ? it.category_id : null;
      const res = await client.query(`
        INSERT INTO items (id, sku, name, category_id, price, cost, image_url, deleted_at, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (id) DO UPDATE
          SET sku = $2, name = $3, category_id = $4, price = $5, cost = $6,
              image_url = $7, deleted_at = $8, synced_at = NOW(), updated_at = NOW()
      `, [it.id, v.sku ?? null, it.item_name, categoryId,
          v.default_price ?? null, v.cost ?? null, it.image_url || null, it.deleted_at || null]);
      inserted += res.rowCount;
    }
    await client.query(`
      UPDATE items SET deleted_at = NOW(), updated_at = NOW()
      WHERE deleted_at IS NULL AND NOT (id = ANY($1::uuid[]))
    `, [items.map(i => i.id)]);

    await rebuildItemCategories(client);

    await client.query('COMMIT');
    console.log(`✅ [items-sync] Complete — ${inserted} items upserted`);
    await writeSyncLog({ syncType: 'items', syncDate, status: 'success', triggeredBy, inserted });
    return { status: 'success', inserted };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [items-sync] DB apply failed:', err.message);
    await writeSyncLog({ syncType: 'items', syncDate, status: 'failed', triggeredBy, inserted: 0, error: err.message });
    return { status: 'failed', inserted: 0, error: err.message };
  } finally {
    client.release();
  }
}

async function syncItems(triggeredBy = 'manual') {
  const syncDate = dayjs().tz(tz).format('YYYY-MM-DD');
  let categories, items;
  try {
    categories = await fetchCategories();
    items      = await fetchItems();
  } catch (err) {
    console.error('❌ [items-sync] Loyverse fetch failed:', err.message);
    await writeSyncLog({ syncType: 'items', syncDate, status: 'failed', triggeredBy, inserted: 0, error: err.message });
    return { status: 'failed', inserted: 0, error: err.message };
  }
  return upsertCatalog({ categories, items }, triggeredBy);
}

module.exports = { syncItems, upsertCatalog, rebuildItemCategories };

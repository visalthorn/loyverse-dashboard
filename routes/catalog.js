// Read-only Catalog summary -- category breakdown + last-synced timestamp
// for the /catalog dashboard page. The full item list itself is already
// served by GET /api/items (routes/items.js); this endpoint only adds the
// aggregate view that route doesn't provide. Open to any authenticated
// role, same as /api/items -- this is menu/catalog info, not sensitive.
const router = require('express').Router();
const pool   = require('../db');
const { requireAuth } = require('../middleware/auth');

router.get('/summary', requireAuth, async (req, res) => {
  try {
    const [categoriesRes, uncategorizedRes, totalsRes] = await Promise.all([
      pool.query(`
        WITH cat_counts AS (
          SELECT COALESCE(i.custom_category_id, i.category_id) AS category_id,
                 COUNT(*) AS total_item_count,
                 COUNT(*) FILTER (WHERE i.deleted_at IS NULL) AS active_item_count
          FROM items i
          GROUP BY COALESCE(i.custom_category_id, i.category_id)
        )
        SELECT c.id, COALESCE(c.custom_name, c.name) AS name,
               COALESCE(cc.active_item_count, 0)::int AS active_item_count,
               COALESCE(cc.total_item_count, 0)::int  AS total_item_count
        FROM categories c
        LEFT JOIN cat_counts cc ON cc.category_id = c.id
        WHERE c.deleted_at IS NULL
        ORDER BY COALESCE(c.custom_name, c.name)
      `),
      // Items whose effective category is missing or points at a
      // soft-deleted category -- otherwise they'd silently disappear from
      // the breakdown above instead of being visibly accounted for.
      pool.query(`
        SELECT COUNT(*)::int AS total_item_count,
               COUNT(*) FILTER (WHERE i.deleted_at IS NULL)::int AS active_item_count
        FROM items i
        WHERE COALESCE(i.custom_category_id, i.category_id) IS NULL
           OR COALESCE(i.custom_category_id, i.category_id) NOT IN (
                SELECT id FROM categories WHERE deleted_at IS NULL
              )
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM items) AS total_items,
          (SELECT COUNT(*)::int FROM items WHERE deleted_at IS NULL) AS active_items,
          (SELECT COUNT(*)::int FROM categories WHERE deleted_at IS NULL) AS total_categories,
          (SELECT MAX(synced_at) FROM items) AS last_synced_at
      `),
    ]);

    const categories = categoriesRes.rows;
    const uncategorized = uncategorizedRes.rows[0];
    // name: null -- deliberately left for the frontend to translate
    // (catalog.uncategorized), rather than hardcoding an English label here.
    if (uncategorized.total_item_count > 0) {
      categories.push({ id: null, name: null, ...uncategorized });
    }

    res.json({ categories, ...totalsRes.rows[0] });
  } catch (err) {
    console.error('Catalog summary GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

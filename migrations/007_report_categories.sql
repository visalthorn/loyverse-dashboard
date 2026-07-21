-- Report Categories: a curated, admin-managed grouping of specific items,
-- independent of the existing Loyverse-derived categories/item_categories.category
-- (that mapping is 1:1 with Loyverse's native category; this one is hand-picked
-- per item, purely for the Summary Report's per-category chart grid).
-- Idempotent: safe to run more than once.

BEGIN;

CREATE TABLE IF NOT EXISTS report_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE items ADD COLUMN IF NOT EXISTS report_category_id INTEGER REFERENCES report_categories(id) ON DELETE SET NULL;

ALTER TABLE item_categories ADD COLUMN IF NOT EXISTS report_category TEXT;

COMMIT;

-- Sanity check
SELECT
  (SELECT COUNT(*) FROM report_categories) AS report_category_count,
  (SELECT COUNT(*) FROM items WHERE report_category_id IS NOT NULL) AS items_with_report_category;

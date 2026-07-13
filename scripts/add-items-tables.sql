-- Items management + centralized Loyverse sync: schema migration.
-- SQL mirror of scripts/add-items-tables.js for running manually
-- (e.g. in the Supabase SQL editor). Safe to run more than once.

BEGIN;

CREATE TABLE IF NOT EXISTS categories (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  custom_name TEXT,
  color       TEXT,
  deleted_at  TIMESTAMPTZ,
  synced_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS items (
  id                 UUID PRIMARY KEY,
  sku                TEXT,
  name               TEXT NOT NULL,
  custom_name        TEXT,
  category_id        UUID REFERENCES categories(id) ON DELETE SET NULL,
  custom_category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  price              NUMERIC,
  cost               NUMERIC,
  image_url          TEXT,
  deleted_at         TIMESTAMPTZ,
  synced_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS item_categories (
  sku      TEXT PRIMARY KEY,
  category TEXT NOT NULL
);

ALTER TABLE sync_logs
  ADD COLUMN IF NOT EXISTS sync_type VARCHAR(20) NOT NULL DEFAULT 'receipts';

CREATE TABLE IF NOT EXISTS role_permissions (
  role      VARCHAR(20) NOT NULL,
  page      VARCHAR(50) NOT NULL,
  can_write BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (role, page)
);

-- Guarded insert: works even if role_permissions has no unique constraint on (role, page)
INSERT INTO role_permissions (role, page, can_write)
SELECT 'manager', 'items', false
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions WHERE role = 'manager' AND page = 'items'
);

COMMIT;

-- Sanity check: every column should be non-null / count 1
SELECT to_regclass('public.categories')      AS categories_table,
       to_regclass('public.items')           AS items_table,
       to_regclass('public.item_categories') AS item_categories_table,
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = 'sync_logs' AND column_name = 'sync_type') AS sync_type_column,
       (SELECT COUNT(*) FROM role_permissions
        WHERE role = 'manager' AND page = 'items') AS manager_items_permission;

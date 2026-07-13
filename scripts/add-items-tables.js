const pool = require('../db');

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id          UUID PRIMARY KEY,
      name        TEXT NOT NULL,
      custom_name TEXT,
      color       TEXT,
      deleted_at  TIMESTAMPTZ,
      synced_at   TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✅ categories table present');

  await pool.query(`
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
    )
  `);
  console.log('✅ items table present');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS item_categories (
      sku      TEXT PRIMARY KEY,
      category TEXT NOT NULL
    )
  `);
  // Upgrade a pre-existing hand-maintained table (PROD had category limited to
  // food/beverage by a check constraint, plus a legacy item_name column).
  await pool.query(`
    ALTER TABLE item_categories DROP CONSTRAINT IF EXISTS item_categories_category_check
  `);
  await pool.query(`
    ALTER TABLE item_categories DROP COLUMN IF EXISTS item_name
  `);
  console.log('✅ item_categories table present');

  await pool.query(`
    ALTER TABLE sync_logs
      ADD COLUMN IF NOT EXISTS sync_type VARCHAR(20) NOT NULL DEFAULT 'receipts'
  `);
  console.log('✅ sync_logs.sync_type column present');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role      VARCHAR(20) NOT NULL,
      page      VARCHAR(50) NOT NULL,
      can_write BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (role, page)
    )
  `);
  console.log('✅ role_permissions table present');

  await pool.query(`
    INSERT INTO role_permissions (role, page, can_write)
    VALUES ('manager', 'items', false)
    ON CONFLICT DO NOTHING
  `);
  console.log('✅ role_permissions items row present');
}

migrate()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  });

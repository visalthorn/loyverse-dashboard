const pool = require('../db');

async function migrate() {
  await pool.query(`
    ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'dashboard',
      ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT
  `);
  console.log('✅ expenses table migrated: source, telegram_message_id columns present');
}

migrate()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  });

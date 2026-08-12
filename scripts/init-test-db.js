// Builds (or fully resets) the dedicated TEST database that test/money/
// runs against. Never touches UAT or PROD -- refuses to run unless ENV=TEST
// and the target database name actually looks like a test database, so a
// misconfigured .env can't turn this into "DROP SCHEMA public CASCADE" on
// something real.
//
// Usage: npm run db:test:init   (= cross-env ENV=TEST node scripts/init-test-db.js)
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ENV = process.env.ENV;
const dbName = process.env.DB_NAME_TEST;

if (ENV !== 'TEST') {
  console.error(`Refusing to run: ENV must be "TEST" (got ${JSON.stringify(ENV)}). Use: npm run db:test:init`);
  process.exit(1);
}
if (!dbName || !/^[a-z0-9_]*test[a-z0-9_]*$/i.test(dbName)) {
  console.error(`Refusing to run: DB_NAME_TEST (${JSON.stringify(dbName)}) doesn't look like a test database name.`);
  process.exit(1);
}

const connBase = {
  host:     process.env.DB_HOST_TEST || 'localhost',
  port:     parseInt(process.env.DB_PORT_TEST) || 5432,
  user:     process.env.DB_USER_TEST,
  password: process.env.DB_PASSWORD_TEST,
};

async function ensureDatabaseExists() {
  const admin = new Client({ ...connBase, database: 'postgres' });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length) {
      console.log(`Database "${dbName}" already exists.`);
      return;
    }
    // CREATE DATABASE can't be parameterized -- dbName was already validated
    // above against /^[a-z0-9_]*test[a-z0-9_]*$/i.
    await admin.query(`CREATE DATABASE ${dbName}`);
    console.log(`Created database "${dbName}".`);
  } finally {
    await admin.end();
  }
}

async function resetSchema() {
  const client = new Client({ ...connBase, database: dbName });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT current_database() AS db');
    if (rows[0].db !== dbName) throw new Error(`Connected to "${rows[0].db}", expected "${dbName}".`);

    console.log(`Resetting schema on "${dbName}"...`);
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'schema.sql'), 'utf8');
    await client.query(schemaSql);
    console.log('Schema applied.');
  } finally {
    await client.end();
  }
}

async function main() {
  await ensureDatabaseExists();
  await resetSchema();
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });

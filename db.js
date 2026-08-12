const { Pool } = require('pg');
const path = require('path');

// .env is in the same folder as this file: c:\inetpub\wwwroot\dashboard\.env
require('dotenv').config({ path: path.join(__dirname, '.env') });

const ENV = process.env.ENV || 'UAT';

console.log(`\n🔧 DB Config loading...`);
console.log(`📌 ENV = ${ENV}`);

let pool;

if (ENV === 'PROD') {
  console.log('🌐 Using PROD (Supabase)');
  pool = new Pool({
    host:     process.env.DB_HOST_PROD,
    port:     parseInt(process.env.DB_PORT_PROD) || 6543,
    user:     process.env.DB_USER_PROD,
    password: process.env.DB_PASSWORD_PROD,
    database: process.env.DB_NAME_PROD || 'postgres',
    ssl: { rejectUnauthorized: false }
  });
} else if (ENV === 'TEST') {
  // Dedicated database for test/money/ (see scripts/init-test-db.js) --
  // never UAT or PROD. Fail loudly rather than silently running tests
  // against the wrong database if DB_NAME_TEST is missing or misconfigured.
  console.log('🧪 Using TEST (isolated local DB)');
  const dbName = process.env.DB_NAME_TEST;
  if (!dbName || !/test/i.test(dbName)) {
    throw new Error(`ENV=TEST but DB_NAME_TEST (${JSON.stringify(dbName)}) doesn't look like a test database. Refusing to connect.`);
  }
  pool = new Pool({
    host:     process.env.DB_HOST_TEST || 'localhost',
    port:     parseInt(process.env.DB_PORT_TEST) || 5432,
    user:     process.env.DB_USER_TEST,
    password: process.env.DB_PASSWORD_TEST,
    database: dbName,
  });
} else {
  console.log('🖥  Using UAT (Local DB)');
  pool = new Pool({
    host:     process.env.DB_HOST_UAT || 'localhost',
    port:     parseInt(process.env.DB_PORT_UAT) || 5432,
    user:     process.env.DB_USER_UAT,
    password: process.env.DB_PASSWORD_UAT,
    database: process.env.DB_NAME_UAT
  });
}

pool.on('query', (query) => {
  console.log('📍 Query:', query.text);
  console.log('📌 Params:', query.values);
});

// Test connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection FAILED:', err.message);
  } else {
    console.log('✅ Database connected at:', res.rows[0].now);
  }
});

module.exports = pool;

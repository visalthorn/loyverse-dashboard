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

// Test connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection FAILED:', err.message);
  } else {
    console.log('✅ Database connected at:', res.rows[0].now);
  }
});

module.exports = pool;

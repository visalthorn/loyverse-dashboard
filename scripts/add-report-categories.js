const fs   = require('fs');
const path = require('path');
const pool = require('../db');

const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '007_report_categories.sql'), 'utf8');

pool.query(sql)
  .then(() => { console.log('✅ 007_report_categories applied'); process.exit(0); })
  .catch(err => { console.error('❌ Migration failed:', err.message); process.exit(1); });

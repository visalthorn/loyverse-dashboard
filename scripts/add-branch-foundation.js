const fs   = require('fs');
const path = require('path');
const pool = require('../db');

const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '005_branch_foundation.sql'), 'utf8');

pool.query(sql)
  .then(() => { console.log('✅ 005_branch_foundation applied'); process.exit(0); })
  .catch(err => { console.error('❌ Migration failed:', err.message); process.exit(1); });

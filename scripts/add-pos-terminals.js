const fs   = require('fs');
const path = require('path');
const pool = require('../db');

const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '009_pos_terminals.sql'), 'utf8');

pool.query(sql)
  .then((result) => {
    console.log('✅ 009_pos_terminals applied');
    console.log(result[result.length - 1]?.rows?.[0] ?? '');
    process.exit(0);
  })
  .catch(err => { console.error('❌ Migration failed:', err.message); process.exit(1); });

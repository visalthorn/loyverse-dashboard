// One-off dev utility: introspects the local UAT Postgres database and emits
// test/fixtures/schema.sql -- full CREATE TABLE/VIEW DDL for exactly the
// tables the money-correctness test suite (test/money/) needs.
//
// Why introspection instead of replaying migrations/*.sql: the tables the
// money suite cares about (receipts, receipt_items, receipt_payments,
// expenses, sync_logs) predate the migrations/ folder (it starts at 002),
// so there is no single script that creates them from scratch. There's also
// no pg_dump/psql CLI available in this environment. Introspecting the live
// UAT schema sidesteps both problems and stays exactly in sync with reality.
//
// Re-run with `node scripts/dump-test-schema.js` any time the schema of one
// of the TABLES/VIEWS below changes. Always connects to UAT -- never PROD.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Exactly the tables the three v_*_all views (below) and the money test
// suite touch. Foreign-key constraints are deliberately NOT reproduced (see
// constraintDDL) so this list doesn't have to drag in the rest of the POS/
// terminal schema graph (pos_terminals, terminal_devices, pos_orders, ...)
// just to satisfy FKs nothing in test/money/ exercises.
const TABLES = [
  'branches', 'pos_devices', 'pos_receipts', 'pos_receipt_items', 'pos_receipt_payments',
  'receipts', 'receipt_items', 'receipt_payments', 'expenses', 'sync_logs', 'sync_runs',
];
const VIEWS = ['v_receipts_all', 'v_receipt_items_all', 'v_receipt_payments_all'];

const TYPE_MAP = {
  'character varying': (c) => c.character_maximum_length ? `VARCHAR(${c.character_maximum_length})` : 'VARCHAR',
  'text': () => 'TEXT',
  'integer': () => 'INTEGER',
  'bigint': () => 'BIGINT',
  'numeric': (c) => (c.numeric_precision != null && c.numeric_scale != null)
    ? `NUMERIC(${c.numeric_precision},${c.numeric_scale})` : 'NUMERIC',
  'boolean': () => 'BOOLEAN',
  'uuid': () => 'UUID',
  'date': () => 'DATE',
  'timestamp without time zone': () => 'TIMESTAMP',
  'timestamp with time zone': () => 'TIMESTAMPTZ',
  'jsonb': () => 'JSONB',
};

function sqlType(col) {
  const fn = TYPE_MAP[col.data_type];
  if (!fn) throw new Error(`Unmapped data_type "${col.data_type}" on ${col.table_name}.${col.column_name}`);
  return fn(col);
}

async function tableDDL(pool, table) {
  const { rows: cols } = await pool.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default,
           character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns WHERE table_schema='public' AND table_name=$1
    ORDER BY ordinal_position
  `, [table]);
  if (!cols.length) throw new Error(`Table "${table}" not found in UAT -- adjust TABLES or check the DB.`);

  const lines = cols.map(c => {
    const isOwnSequence = typeof c.column_default === 'string'
      && c.column_default.startsWith(`nextval('${table}_${c.column_name}_seq'`);
    const colName = `"${c.column_name}"`; // reserved words like "order" need quoting
    if (isOwnSequence && c.data_type === 'integer') return `  ${colName} SERIAL`;
    if (isOwnSequence && c.data_type === 'bigint')   return `  ${colName} BIGSERIAL`;

    let line = `  ${colName} ${sqlType(c)}`;
    if (c.is_nullable === 'NO') line += ' NOT NULL';
    if (c.column_default != null && !isOwnSequence) line += ` DEFAULT ${c.column_default}`;
    return line;
  });

  return `CREATE TABLE ${table} (\n${lines.join(',\n')}\n);`;
}

async function constraintDDL(pool, table) {
  const { rows } = await pool.query(`
    SELECT conname, pg_get_constraintdef(oid) AS def, contype
    FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY contype
  `, [table]);
  return rows
    // NOT NULL constraints (contype 'n') are already expressed as column
    // NOT NULL above. Foreign keys (contype 'f') are deliberately skipped --
    // see the TABLES comment above; this test schema doesn't need
    // referential integrity against tables outside TABLES.
    .filter(r => r.contype !== 'n' && r.contype !== 'f')
    .map(r => `ALTER TABLE ${table} ADD CONSTRAINT ${r.conname} ${r.def};`);
}

async function indexDDL(pool, table) {
  const { rows } = await pool.query(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename=$1
      AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass)
  `, [table]);
  return rows.map(r => `${r.indexdef};`);
}

async function viewDDL(pool, view) {
  const { rows } = await pool.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [view]);
  if (!rows.length) throw new Error(`View "${view}" not found in UAT.`);
  return `CREATE OR REPLACE VIEW ${view} AS\n${rows[0].def.trim().replace(/;+$/, '')}`;
}

async function main() {
  const pool = new Pool({
    host:     process.env.DB_HOST_UAT || 'localhost',
    port:     parseInt(process.env.DB_PORT_UAT) || 5432,
    user:     process.env.DB_USER_UAT,
    password: process.env.DB_PASSWORD_UAT,
    database: process.env.DB_NAME_UAT,
  });

  const parts = [
    '-- GENERATED FILE -- do not hand-edit.',
    '-- Produced by scripts/dump-test-schema.js from the local UAT schema.',
    '-- Applied fresh into loyverse_db_test by scripts/init-test-db.js.',
    '',
  ];

  for (const table of TABLES) {
    parts.push(`-- ${table} ` + '-'.repeat(Math.max(0, 60 - table.length)));
    parts.push(await tableDDL(pool, table));
    const constraints = await constraintDDL(pool, table);
    if (constraints.length) parts.push(...constraints);
    const indexes = await indexDDL(pool, table);
    if (indexes.length) parts.push(...indexes);
    parts.push('');
  }

  for (const view of VIEWS) {
    parts.push(`-- ${view} ` + '-'.repeat(Math.max(0, 60 - view.length)));
    parts.push((await viewDDL(pool, view)) + ';');
    parts.push('');
  }

  const outPath = path.join(__dirname, '..', 'test', 'fixtures', 'schema.sql');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, parts.join('\n'));
  console.log(`Wrote ${outPath}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });

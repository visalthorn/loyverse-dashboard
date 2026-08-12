// Migration runner. See migrations/README.md for the full policy (forward-only,
// no rollback, checksums, baselining).
//
// Usage -- ALWAYS requires an explicit --env flag, deliberately NOT reusing
// db.js's implicit ENV fallback: this repo's own history shows a bare `node`
// command silently resolves to PROD via .env's ENV=PROD default (see
// memory/env-defaults-to-prod-shell.md) -- exactly the failure mode a
// migration runner can least afford. `npm run migrate` with no --env fails
// fast instead of guessing.
//   npm run migrate -- --env=uat            -- apply all pending migrations
//   npm run migrate:status -- --env=uat     -- list applied vs pending, read-only
//   node scripts/migrate.js --env=prod --baseline
//     -- mark every currently-pending migration as applied WITHOUT running
//        its SQL. For a database whose schema already reflects that history
//        (e.g. it predates this tool). Never use this on a database that
//        does NOT already have the schema those files describe.
//   node scripts/migrate.js --env=prod --baseline --up-to=032
//     -- same, but only through version 032 -- anything after that stays
//        pending for a real `migrate` run. Use when some later migrations
//        genuinely haven't run yet and baselining them would just paper
//        over that instead of actually applying them.
//
// applied_by defaults to the OS username; override with MIGRATE_APPLIED_BY=name.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const APPLIED_BY = process.env.MIGRATE_APPLIED_BY || os.userInfo().username;

function buildPool(envArg) {
  const target = (envArg || '').toUpperCase();
  if (!['UAT', 'PROD', 'TEST'].includes(target)) {
    console.error('❌ Refusing to run: pass --env=uat, --env=prod, or --env=test explicitly.');
    console.error('   (This tool never falls back to a default -- .env\'s ENV=PROD default has bitten this repo before.)');
    process.exit(1);
  }
  console.log(`🎯 Target: ${target}`);
  if (target === 'PROD') {
    return new Pool({
      host: process.env.DB_HOST_PROD, port: parseInt(process.env.DB_PORT_PROD) || 6543,
      user: process.env.DB_USER_PROD, password: process.env.DB_PASSWORD_PROD,
      database: process.env.DB_NAME_PROD || 'postgres', ssl: { rejectUnauthorized: false },
    });
  }
  if (target === 'TEST') {
    const dbName = process.env.DB_NAME_TEST;
    if (!dbName || !/test/i.test(dbName)) {
      console.error(`❌ Refusing to run: DB_NAME_TEST (${JSON.stringify(dbName)}) doesn't look like a test database.`);
      process.exit(1);
    }
    return new Pool({
      host: process.env.DB_HOST_TEST || 'localhost', port: parseInt(process.env.DB_PORT_TEST) || 5432,
      user: process.env.DB_USER_TEST, password: process.env.DB_PASSWORD_TEST, database: dbName,
    });
  }
  return new Pool({
    host: process.env.DB_HOST_UAT || 'localhost', port: parseInt(process.env.DB_PORT_UAT) || 5432,
    user: process.env.DB_USER_UAT, password: process.env.DB_PASSWORD_UAT, database: process.env.DB_NAME_UAT,
  });
}

const envArg = (process.argv.find(a => a.startsWith('--env=')) || '').split('=')[1];
const pool = buildPool(envArg);

function loadMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort() // "001" < "001a" < "001b" < "002" < ... < "028" < "028a" < "029" < ... -- plain string sort is correct here because every numeric prefix is zero-padded to the same width.
    .map(filename => {
      const version = filename.split('_')[0];
      const fullPath = path.join(MIGRATIONS_DIR, filename);
      const sql = fs.readFileSync(fullPath, 'utf8');
      const checksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
      return { version, filename, sql, checksum };
    });
}

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     VARCHAR(20) PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      checksum    VARCHAR(64) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_by  VARCHAR(100) NOT NULL
    )
  `);
}

async function getAppliedByVersion() {
  const { rows } = await pool.query('SELECT version, name, checksum, applied_at, applied_by FROM schema_migrations');
  return new Map(rows.map(r => [r.version, r]));
}

// Refuses to proceed if any migration already recorded as applied has a
// filename whose current on-disk content no longer matches the checksum
// recorded at apply time -- forces a NEW migration instead of editing an
// already-applied file. Runs before every mutating command (migrate, baseline).
function verifyChecksums(files, appliedByVersion) {
  const mismatches = [];
  for (const f of files) {
    const applied = appliedByVersion.get(f.version);
    if (applied && applied.checksum !== f.checksum) {
      mismatches.push({ version: f.version, filename: f.filename, expected: applied.checksum, actual: f.checksum });
    }
  }
  if (mismatches.length) {
    console.error('❌ Refusing to run: the following already-applied migration file(s) have changed on disk:\n');
    for (const m of mismatches) {
      console.error(`  ${m.filename}`);
      console.error(`    applied checksum: ${m.expected}`);
      console.error(`    current checksum: ${m.actual}`);
    }
    console.error('\nMigrations are immutable once applied. Create a new migration instead of editing this one.');
    process.exit(1);
  }
}

async function runMigrate() {
  await ensureMigrationsTable();
  const files = loadMigrationFiles();
  const appliedByVersion = await getAppliedByVersion();
  verifyChecksums(files, appliedByVersion);

  const pending = files.filter(f => !appliedByVersion.has(f.version));
  if (!pending.length) {
    console.log('✅ Nothing to apply -- database is up to date.');
    return;
  }

  console.log(`Applying ${pending.length} pending migration(s):\n`);
  for (const f of pending) {
    process.stdout.write(`  ${f.filename} ... `);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(f.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum, applied_by) VALUES ($1, $2, $3, $4)',
        [f.version, f.filename, f.checksum, APPLIED_BY]
      );
      await client.query('COMMIT');
      console.log('OK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.log('FAILED');
      console.error(`\n❌ ${f.filename} failed: ${err.message}`);
      console.error('Stopped -- migrations after this one were not attempted.');
      process.exitCode = 1;
      return;
    } finally {
      client.release();
    }
  }
  console.log('\n✅ Done.');
}

async function runStatus() {
  await ensureMigrationsTable();
  const files = loadMigrationFiles();
  const appliedByVersion = await getAppliedByVersion();

  console.log(`${'VERSION'.padEnd(8)} ${'STATUS'.padEnd(10)} ${'APPLIED AT'.padEnd(22)} ${'APPLIED BY'.padEnd(15)} FILE`);
  for (const f of files) {
    const applied = appliedByVersion.get(f.version);
    if (!applied) {
      console.log(`${f.version.padEnd(8)} ${'pending'.padEnd(10)} ${''.padEnd(22)} ${''.padEnd(15)} ${f.filename}`);
      continue;
    }
    const mismatch = applied.checksum !== f.checksum;
    const status = mismatch ? 'MODIFIED!' : 'applied';
    console.log(`${f.version.padEnd(8)} ${status.padEnd(10)} ${applied.applied_at.toISOString().padEnd(22)} ${applied.applied_by.padEnd(15)} ${f.filename}`);
  }

  const pendingCount = files.filter(f => !appliedByVersion.has(f.version)).length;
  console.log(`\n${files.length - pendingCount} applied, ${pendingCount} pending, ${files.length} total.`);
}

async function runBaseline(upToVersion) {
  await ensureMigrationsTable();
  const files = loadMigrationFiles();
  const appliedByVersion = await getAppliedByVersion();
  verifyChecksums(files, appliedByVersion);

  let eligible = files;
  if (upToVersion) {
    const cutoffIndex = files.findIndex(f => f.version === upToVersion);
    if (cutoffIndex === -1) {
      console.error(`❌ No migration file with version "${upToVersion}" found.`);
      process.exit(1);
    }
    eligible = files.slice(0, cutoffIndex + 1);
    console.log(`(--up-to=${upToVersion}: only considering ${eligible.length} of ${files.length} files)`);
  }

  const pending = eligible.filter(f => !appliedByVersion.has(f.version));
  if (!pending.length) {
    console.log('✅ Nothing to baseline -- every migration is already recorded as applied.');
    return;
  }

  console.log(`Baselining ${pending.length} migration(s) as already-applied (SQL will NOT be executed):\n`);
  for (const f of pending) {
    await pool.query(
      'INSERT INTO schema_migrations (version, name, checksum, applied_by) VALUES ($1, $2, $3, $4)',
      [f.version, f.filename, f.checksum, `${APPLIED_BY} (baseline)`]
    );
    console.log(`  ${f.filename} ... marked applied`);
  }
  console.log('\n✅ Done. The database schema itself was NOT modified.');
}

async function main() {
  const args = process.argv.slice(2);
  const upToArg = (args.find(a => a.startsWith('--up-to=')) || '').split('=')[1] || null;
  try {
    if (args.includes('--baseline')) await runBaseline(upToArg);
    else if (args.includes('--status')) await runStatus();
    else await runMigrate();
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });

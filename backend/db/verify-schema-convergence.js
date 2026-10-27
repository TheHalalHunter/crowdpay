'use strict';

/**
 * Verify that the database contains every table declared by the application
 * schema and migrations, and optionally compare its structure with a second
 * database bootstrap path.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://crowdpay:crowdpay@localhost:5432/crowdpay';
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function expectedTables() {
  const files = [
    SCHEMA_FILE,
    ...fs
      .readdirSync(MIGRATIONS_DIR)
      .filter(file => file.endsWith('.sql') && !file.endsWith('.down.sql'))
      .sort()
      .map(file => path.join(MIGRATIONS_DIR, file)),
  ];
  const tables = new Set(['schema_migrations']);
  const createTable = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w]+\.)?"?([\w]+)"?/gi;

  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');
    for (const match of sql.matchAll(createTable)) tables.add(match[1].toLowerCase());
  }
  return [...tables].sort();
}

async function readSnapshot(pool) {
  const { rows } = await pool.query(`
    SELECT table_name, column_name, data_type,
           udt_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, column_name
  `);
  return rows.map(normalizeColumnRow);
}

/**
 * Physical column order is intentionally not part of the convergence
 * contract. PostgreSQL assigns ordinal_position at CREATE TABLE time and has
 * no supported ALTER that reorders columns, so a migrations-only database
 * appends later columns while a schema.sql bootstrap may declare them inline.
 * Both paths must expose the same columns with the same type, nullability and
 * default; their ordinal positions are an implementation detail (#1045).
 */
function normalizeColumnRow(row) {
  return {
    table_name: row.table_name,
    column_name: row.column_name,
    data_type: row.data_type,
    udt_name: row.udt_name,
    is_nullable: row.is_nullable,
    column_default: row.column_default,
  };
}

function tableNames(snapshot) {
  return [...new Set(snapshot.map(row => row.table_name))].sort();
}

function validateExpectedTables(snapshot) {
  const actual = new Set(tableNames(snapshot));
  return expectedTables()
    .filter(table => !actual.has(table))
    .map(table => `table '${table}' is missing`);
}

async function validateCanonicalData(pool) {
  const failures = [];
  const { rows: featureFlagColumns } = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_name = 'feature_flags'
     ORDER BY column_name
  `);
  const expectedFeatureFlagColumns = [
    'default_enabled',
    'description',
    'enabled',
    'key',
    'updated_at',
  ];
  const actualFeatureFlagColumns = featureFlagColumns.map(row => row.column_name);
  if (JSON.stringify(actualFeatureFlagColumns) !== JSON.stringify(expectedFeatureFlagColumns)) {
    failures.push(
      `feature_flags columns drift: expected [${expectedFeatureFlagColumns.join(', ')}], got [${actualFeatureFlagColumns.join(', ')}]`
    );
  }

  const { rows: flagRows } = await pool.query('SELECT COUNT(*)::int AS n FROM feature_flags');
  if (flagRows[0].n < 4)
    failures.push(`feature_flags seed rows missing: expected >= 4, found ${flagRows[0].n}`);

  const { rows: templateColumns } = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_name = 'campaign_templates'
     ORDER BY column_name
  `);
  const expectedTemplateColumns = [
    'category',
    'created_at',
    'description',
    'id',
    'is_active',
    'name',
    'slug',
    'template_data',
    'updated_at',
    'use_count',
  ];
  const actualTemplateColumns = templateColumns.map(row => row.column_name);
  if (JSON.stringify(actualTemplateColumns) !== JSON.stringify(expectedTemplateColumns)) {
    failures.push(
      `campaign_templates columns drift: expected [${expectedTemplateColumns.join(', ')}], got [${actualTemplateColumns.join(', ')}]`
    );
  }
  const { rows: templateRows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM campaign_templates'
  );
  if (templateRows[0].n < 1) failures.push('campaign_templates has no seed rows after migration');
  return failures;
}

function compareSnapshots(actualInput, expectedInput) {
  // Accept snapshots written by older versions of this script too, but never
  // let a legacy `ordinal_position` field turn an equivalent schema into a
  // failure.
  const actual = actualInput.map(normalizeColumnRow);
  const expected = expectedInput.map(normalizeColumnRow);
  if (JSON.stringify(actual) === JSON.stringify(expected)) return [];

  const actualTables = new Set(tableNames(actual));
  const expectedTableNames = new Set(tableNames(expected));
  const failures = [];
  for (const table of [...expectedTableNames].filter(name => !actualTables.has(name))) {
    failures.push(`comparison database is missing table '${table}'`);
  }
  for (const table of [...actualTables].filter(name => !expectedTableNames.has(name))) {
    failures.push(`comparison database has unexpected table '${table}'`);
  }

  const groupByTable = rows => {
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.table_name)) grouped.set(row.table_name, []);
      grouped.get(row.table_name).push(row);
    }
    return grouped;
  };
  const actualByTable = groupByTable(actual);
  const expectedByTable = groupByTable(expected);
  for (const table of new Set([...actualByTable.keys(), ...expectedByTable.keys()])) {
    if (
      JSON.stringify(actualByTable.get(table) || []) !==
      JSON.stringify(expectedByTable.get(table) || [])
    ) {
      failures.push(`columns differ for table '${table}'`);
    }
  }
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  const writeIndex = args.indexOf('--write-snapshot');
  const compareIndex = args.indexOf('--compare-snapshot');
  const writePath = writeIndex >= 0 ? args[writeIndex + 1] : null;
  const comparePath = compareIndex >= 0 ? args[compareIndex + 1] : null;
  if ((writeIndex >= 0 && !writePath) || (compareIndex >= 0 && !comparePath)) {
    throw new Error(
      'Usage: node db/verify-schema-convergence.js [--write-snapshot path | --compare-snapshot path]'
    );
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const snapshot = await readSnapshot(pool);
    const failures = [...validateExpectedTables(snapshot), ...(await validateCanonicalData(pool))];
    if (comparePath) {
      failures.push(
        ...compareSnapshots(snapshot, JSON.parse(fs.readFileSync(comparePath, 'utf8')))
      );
    }
    if (writePath) fs.writeFileSync(writePath, `${JSON.stringify(snapshot, null, 2)}\n`);
    if (failures.length) {
      console.error('[verify-schema] FAILED:');
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[verify-schema] OK: ${tableNames(snapshot).length} public tables verified.`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('[verify-schema] Failed to run check:', err.message);
  process.exitCode = 1;
});

module.exports = {
  compareSnapshots,
  expectedTables,
  readSnapshot,
  validateCanonicalData,
  validateExpectedTables,
};

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DOWN_SUFFIX = '.down.sql';

function isUpMigration(filename) {
  return filename.endsWith('.sql') && !filename.endsWith(DOWN_SUFFIX);
}

function validateMigrationFiles() {
  const all = listAllMigrationFilenames();
  for (const f of all) {
    if (!f.endsWith('.sql')) {
      throw new Error(
        `Unsupported migration file format: '${f}'. Supported formats are: .sql (e.g. .sql, .down.sql).`
      );
    }
  }
}

function listAllMigrationFilenames() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => !f.startsWith('.'))
    .sort();
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function listUpMigrationFilenames() {
  return fs.readdirSync(MIGRATIONS_DIR).filter(isUpMigration).sort();
}

function downFilenameFor(upFile) {
  return upFile.replace(/\.sql$/, DOWN_SUFFIX);
}

function filePathFor(upFile) {
  return path.join(MIGRATIONS_DIR, upFile);
}

function readUpSql(upFile) {
  return fs.readFileSync(filePathFor(upFile), 'utf8');
}

function fileHashFor(upFile) {
  return sha256(readUpSql(upFile));
}

function readDownSql(upFile) {
  const downFile = downFilenameFor(upFile);
  const p = filePathFor(downFile);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

async function ensureSchemaMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW(),
      file_hash TEXT
    )
  `);
  // Backfill the hash column on databases created before hash tracking was added.
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS file_hash TEXT');
}

async function loadApplied(client) {
  const { rows } = await client.query(
    'SELECT filename, file_hash, applied_at FROM schema_migrations'
  );
  return rows;
}

const MIGRATION_ADVISORY_LOCK_KEY = 894721;

async function acquireMigrationLock(client, lockKey = MIGRATION_ADVISORY_LOCK_KEY) {
  await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
  return true;
}

async function releaseMigrationLock(client, lockKey = MIGRATION_ADVISORY_LOCK_KEY) {
  const { rows } = await client.query('SELECT pg_advisory_unlock($1) AS unlocked', [lockKey]);
  return rows && rows[0] ? rows[0].unlocked : true;
}

module.exports = {
  MIGRATIONS_DIR,
  DOWN_SUFFIX,
  MIGRATION_ADVISORY_LOCK_KEY,
  acquireMigrationLock,
  releaseMigrationLock,
  isUpMigration,
  sha256,
  listUpMigrationFilenames,
  downFilenameFor,
  readUpSql,
  readDownSql,
  fileHashFor,
  ensureSchemaMigrationsTable,
  listAllMigrationFilenames,
  validateMigrationFiles,
  loadApplied,
};

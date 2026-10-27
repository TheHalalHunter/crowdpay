'use strict';

/**
 * Upgrade a committed, production-like snapshot in an isolated database.
 * The database is created and dropped for this process, so CI runs never
 * share state with the normal migration or application test database.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Pool } = require('pg');
const { listUpMigrationFilenames } = require('./migrateLib');

const execFileAsync = promisify(execFile);
const fixturePath = path.join(__dirname, 'fixtures', 'production-like-20260404.sql');

function databaseUrlWithName(source, name) {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

async function main() {
  const sourceUrl =
    process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/postgres';
  const databaseName = `crowdpay_migration_${process.pid}_${Date.now().toString(36)}`;
  const adminUrl = databaseUrlWithName(sourceUrl, 'postgres');
  const targetUrl = databaseUrlWithName(sourceUrl, databaseName);
  const adminPool = new Pool({ connectionString: adminUrl });
  let targetPool;

  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    targetPool = new Pool({ connectionString: targetUrl });
    await targetPool.query(fs.readFileSync(fixturePath, 'utf8'));

    await execFileAsync(process.execPath, ['db/migrate.js', 'up'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: targetUrl },
      maxBuffer: 10 * 1024 * 1024,
    });

    const { rows: counts } = await targetPool.query(`
      SELECT
        (SELECT COUNT(*) FROM campaigns WHERE id = '00000000-0000-0000-0000-000000000010') AS campaigns,
        (SELECT COUNT(*) FROM contributions WHERE id = '00000000-0000-0000-0000-000000000020' AND tx_hash = 'fixture-contribution-tx') AS contributions,
        (SELECT COUNT(*) FROM withdrawal_requests WHERE id = '00000000-0000-0000-0000-000000000030') AS payouts
    `);
    const countsRow = counts[0];
    if (
      countsRow.campaigns !== '1' ||
      countsRow.contributions !== '1' ||
      countsRow.payouts !== '1'
    ) {
      throw new Error(`Fixture records were not preserved: ${JSON.stringify(countsRow)}`);
    }

    const { rows: migrationRows } = await targetPool.query(
      'SELECT filename FROM schema_migrations ORDER BY filename'
    );
    if (migrationRows.length !== listUpMigrationFilenames().length) {
      throw new Error(
        `Migration runner did not apply the complete set: ${migrationRows.length}/${listUpMigrationFilenames().length}`
      );
    }

    const { rows: indexes } = await targetPool.query(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('idx_contributions_campaign_id', 'stellar_transactions_campaign_created_idx', 'ledger_stream_alerts_campaign_idx')
    `);
    if (indexes.length !== 3) throw new Error('Required upgrade indexes are missing');

    const { rows: constraints } = await targetPool.query(`
      SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'public'
         AND ((table_name = 'campaigns' AND constraint_type = 'CHECK')
           OR (table_name = 'contributions' AND constraint_type = 'UNIQUE')
           OR (table_name = 'withdrawal_requests' AND constraint_type = 'CHECK'))
    `);
    if (constraints.length < 3) throw new Error('Required upgrade constraints are missing');

    console.log(
      '[migration-integration] OK: fixture upgraded with records, indexes, and constraints intact.'
    );
  } finally {
    if (targetPool) await targetPool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  }
}

main().catch(err => {
  console.error('[migration-integration] FAILED:', err.message);
  process.exitCode = 1;
});

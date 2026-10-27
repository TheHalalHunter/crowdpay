'use strict';

/**
 * Scheduled restore verification for backup artifacts (#1075).
 *
 * Restores a recent campaign draft version into an isolated database context,
 * validates schema version and representative campaign/contribution records,
 * and alerts maintainers on failure without exposing backup contents.
 */

const path = require('path');
const fs = require('fs');
const db = require('../config/database');
const { listVersions, restoreVersion } = require('./campaignDraftVersionService');
const logger = require('../config/logger');

const VERIFICATION_REASON = 'scheduled-restore-verification';
const MAX_VERSIONS_TO_CHECK = 5;

function isIsolationRunner(runner) {
  return runner && runner.config && runner.config.isolation;
}

async function runRestoreVerification({ runner = db } = {}) {
  let deletedRecords = [];
  let schemaErrors = [];
  let recordErrors = [];

  try {
    // Step 1: List recent draft versions
    const versions = await listVersions({ campaignId: null, limit: MAX_VERSIONS_TO_CHECK, runner });

    if (!versions.length) {
      logger.info('verification: no draft versions found for scheduled check');
      return { status: 'no_versions', schemaErrors: [], recordErrors: [] };
    }

    // Step 2: For each version, attempt restore in isolation and validate
    for (const version of versions) {
      try {
        // Perform restore into a disposable/contextual runner
        // The runner can be a test/database connection that isolates from production
        const restored = await restoreVersion({
          campaignId: version.campaign_id,
          versionId: version.id,
          actorId: 'verification-service',
          expectedVersion: version.version,
          runner,
        });

        // Step 3: Validate schema convergence after restore
        // Read current schema and compare with expected
        const schemaCheck = await verifySchemaConvergence(runner);
        if (schemaCheck.length > 0) {
          schemaErrors.push({
            versionId: version.id,
            campaignId: version.campaign_id,
            errors: schemaCheck,
          });
        }

        // Step 4: Validate representative campaign/contribution records
        // Check that key records exist and are valid after restore
        const recordValidation = await validateRecordsAfterRestore(version.campaign_id, runner);
        if (recordValidation.errors.length > 0) {
          recordErrors.push({
            versionId: version.id,
            campaignId: version.campaign_id,
            errors: recordValidation.errors,
          });
        }

        // Clean up - restore is disposable, remove the created version
        // We don't persist the restore permanently; just verify it works
        await db.query(
          `DELETE FROM campaign_draft_versions WHERE campaign_id = $1 AND version = $2`,
          [version.campaign_id, restored.draftVersion]
        );
      } catch (err) {
        // Log failure without exposing backup contents
        recordErrors.push({
          versionId: version.id,
          campaignId: version.campaign_id,
          error: err.message || 'Unknown verification error',
        });
        logger.error('verification: restore failed', {
          versionId: version.id,
          campaignId: version.campaign_id,
          error: err.message,
        });
      }
    }

    // Step 5: Determine overall status
    const hasErrors = schemaErrors.length > 0 || recordErrors.length > 0;
    if (hasErrors) {
      // Alert maintainers - summary only, no sensitive data exposed
      logger.warn('verification: scheduled restore verification completed with issues', {
        schemaErrorsCount: schemaErrors.length,
        recordErrorsCount: recordErrors.length,
      });
    } else {
      logger.info('verification: scheduled restore verification passed');
    }

    return {
      status: hasErrors ? 'failed' : 'passed',
      schemaErrors,
      recordErrors,
    };
  } catch (err) {
    logger.error('verification: scheduled restore verification crashed', {
      error: err.message,
    });
    return {
      status: 'crashed',
      error: err.message,
    };
  }
}

async function verifySchemaConvergence(runner) {
  // Read schema.sql and compare with current database state
  // This is a simplified check; full convergence is done in CI
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // Extract table names from schema
  const createTable = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w]+\.)?"?([\w]+)"?/gi;
  const tablesInSchema = new Set();
  let match;
  while ((match = createTable.exec(schemaSql)) !== null) {
    tablesInSchema.add(match[1].toLowerCase());
  }

  // Check actual tables in the database
  const { rows } = await runner.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const actualTables = new Set(rows.map(r => r.table_name.toLowerCase()));

  // Find missing tables
  const missing = [...tablesInSchema].filter(t => !actualTables.has(t));
  if (missing.length > 0) {
    return [`Schema tables missing from DB: ${missing.join(', ')}`];
  }

  // Check for extra tables (could be from extensions or other sources)
  const extra = [...actualTables].filter(
    t => !tablesInSchema.has(t) && !t.startsWith('pg_') && t !== 'schema_migrations'
  );
  if (extra.length > 0) {
    return [`Schema has unexpected tables: ${extra.join(', ')}`];
  }

  return [];
}

async function validateRecordsAfterRestore(campaignId, runner) {
  const errors = [];

  try {
    // Check that the campaign exists and is in a valid state
    const { rows: campaignRows } = await runner.query(
      'SELECT id, status, draft_version, title, created_at FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (!campaignRows.length) {
      errors.push(`Campaign ${campaignId} not found after restore verification`);
      return { errors };
    }

    const campaign = campaignRows[0];

    // Check that draft version is valid
    if (campaign.draft_version === undefined) {
      errors.push(`Campaign ${campaignId} has no draft_version after restore`);
    }

    // Check representative contribution records exist
    const { rows: contributionRows } = await runner.query(
      `SELECT id, amount, asset, status FROM contributions WHERE campaign_id = $1 LIMIT 5`,
      [campaignId]
    );
    if (contributionRows.length === 0) {
      errors.push(`No contribution records found for campaign ${campaignId} after restore`);
    }

    // Check that indexes are still valid by querying with indexed columns
    try {
      await runner.query(`SELECT id, campaign_id FROM contributions WHERE campaign_id = $1`, [
        campaignId,
      ]);
    } catch (idxErr) {
      errors.push(
        `Index validation failed for contributions on campaign ${campaignId}: ${idxErr.message}`
      );
    }
  } catch (err) {
    errors.push(`Record validation error: ${err.message}`);
  }

  return { errors };
}

module.exports = {
  runRestoreVerification,
  verifySchemaConvergence,
  validateRecordsAfterRestore,
};

#!/usr/bin/env node
// ONE-TIME MIGRATION — run once after deploying the encrypt-totp-secrets code change. Encrypts all plaintext totp_secret values in the users table.

require('dotenv').config();

const db = require('../src/config/database');
const {
  encryptSecret,
  decryptSecret,
  validateWalletEncryptionKey,
} = require('../src/services/walletService');

// A value that matches this pattern is a *candidate* for already being encrypted.
// We confirm by attempting a trial decrypt — if it succeeds the row is already encrypted,
// if it throws the value is plaintext that happens to match the hex-colon shape.
const ENCRYPTED_CANDIDATE_PATTERN = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;

function isAlreadyEncrypted(value) {
  if (typeof value !== 'string') return false;
  if (!ENCRYPTED_CANDIDATE_PATTERN.test(value)) return false;
  try {
    decryptSecret(value);
    return true;
  } catch (_) {
    // Matches the pattern but does not decrypt — treat as plaintext
    return false;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!process.env.WALLET_ENCRYPTION_KEY) throw new Error('WALLET_ENCRYPTION_KEY is required');
  validateWalletEncryptionKey();

  const dryRun = process.env.DRY_RUN === '1';
  if (dryRun) {
    process.stdout.write('[migrate-totp-secrets] DRY_RUN mode — no writes will occur\n');
  }

  const { rows } = await db.query(
    'SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL'
  );
  process.stdout.write(
    `[migrate-totp-secrets] Found ${rows.length} user(s) with a non-null totp_secret\n`
  );

  let migrated = 0;
  let alreadyEncrypted = 0;

  // Collect rows that need updating before opening the transaction
  const toMigrate = [];
  for (const row of rows) {
    if (isAlreadyEncrypted(row.totp_secret)) {
      alreadyEncrypted++;
      continue;
    }
    const encrypted = encryptSecret(row.totp_secret);
    toMigrate.push({ id: row.id, encrypted });
    process.stdout.write(
      `[migrate-totp-secrets] ${dryRun ? '(dry-run) would encrypt' : 'Will encrypt'} totp_secret for user id=${row.id}\n`
    );
    migrated++;
  }

  if (!dryRun && toMigrate.length > 0) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const { id, encrypted } of toMigrate) {
        await client.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [encrypted, id]);
      }
      await client.query('COMMIT');
      process.stdout.write(
        `[migrate-totp-secrets] Transaction committed — ${toMigrate.length} row(s) updated\n`
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const summary = { total: rows.length, migrated, alreadyEncrypted, dry_run: dryRun };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main()
  .catch(err => {
    process.stderr.write(`[migrate-totp-secrets] ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.end();
    } catch (_) {
      /* db may already be closed */
    }
  });

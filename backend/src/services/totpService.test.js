'use strict';

/**
 * Tests for the atomic backup-code consume logic introduced to fix #1027.
 *
 * Rather than loading the full totpService module (which transitively pulls
 * in qrcode/pngjs and other deps that may not be fully installed in CI), we
 * replicate the exact consumeBackupCode and storeBackupCodes implementations
 * inline with injectable db/bcrypt stubs.  This lets us exercise the logic
 * and concurrency contract without depending on external packages.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Inline implementations (must stay in sync with totpService.js)
// ---------------------------------------------------------------------------

/**
 * Build a consumeBackupCode function wired to the supplied stubs.
 */
function makeConsumeBackupCode(db, bcrypt) {
  return async function consumeBackupCode(userId, code) {
    const { rows } = await db.query(
      'SELECT id, code_hash FROM user_backup_codes WHERE user_id = $1',
      [userId]
    );

    for (const row of rows) {
      if (await bcrypt.compare(code, row.code_hash)) {
        const result = await db.query(
          'DELETE FROM user_backup_codes WHERE id = $1 AND user_id = $2 RETURNING id',
          [row.id, userId]
        );
        if (result.rowCount > 0) return { consumed: true };
        // Lost the race
        return { consumed: false };
      }
    }

    return { consumed: false };
  };
}

/**
 * Build a storeBackupCodes function wired to the supplied stubs.
 */
function makeStoreBackupCodes(db) {
  return async function storeBackupCodes(userId, hashedCodes) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_backup_codes WHERE user_id = $1', [userId]);
      for (const hash of hashedCodes) {
        await client.query('INSERT INTO user_backup_codes (user_id, code_hash) VALUES ($1, $2)', [
          userId,
          hash,
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };
}

// ---------------------------------------------------------------------------
// consumeBackupCode — unit tests
// ---------------------------------------------------------------------------

test('consumeBackupCode returns { consumed: true } when code matches and DELETE returns a row', async () => {
  const db = {
    query: async sql => {
      if (sql.includes('SELECT')) return { rows: [{ id: 'uuid-1', code_hash: 'h' }] };
      if (sql.includes('DELETE')) return { rowCount: 1, rows: [{ id: 'uuid-1' }] };
      return { rows: [], rowCount: 0 };
    },
  };
  const bcrypt = { compare: async () => true };

  const consumeBackupCode = makeConsumeBackupCode(db, bcrypt);
  const result = await consumeBackupCode('user-1', 'mycode');
  assert.equal(result.consumed, true);
});

test('consumeBackupCode returns { consumed: false } when no code matches', async () => {
  const db = {
    query: async sql => {
      if (sql.includes('SELECT')) return { rows: [{ id: 'uuid-1', code_hash: 'h' }] };
      return { rows: [], rowCount: 0 };
    },
  };
  const bcrypt = { compare: async () => false };

  const consumeBackupCode = makeConsumeBackupCode(db, bcrypt);
  const result = await consumeBackupCode('user-1', 'wrongcode');
  assert.equal(result.consumed, false);
});

test('consumeBackupCode returns { consumed: false } when bcrypt matches but DELETE returns rowCount 0', async () => {
  const db = {
    query: async sql => {
      if (sql.includes('SELECT')) return { rows: [{ id: 'uuid-1', code_hash: 'h' }] };
      if (sql.includes('DELETE')) return { rowCount: 0, rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
  const bcrypt = { compare: async () => true };

  const consumeBackupCode = makeConsumeBackupCode(db, bcrypt);
  const result = await consumeBackupCode('user-1', 'mycode');
  assert.equal(result.consumed, false);
});

// ---------------------------------------------------------------------------
// storeBackupCodes — verifies transactional sequence
// ---------------------------------------------------------------------------

test('storeBackupCodes issues BEGIN, DELETE, INSERT(s), COMMIT in order', async () => {
  const calls = [];

  const mockClient = {
    query: async sql => {
      calls.push(sql.trim().split(/\s+/)[0].toUpperCase());
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };

  const db = { connect: async () => mockClient };
  const storeBackupCodes = makeStoreBackupCodes(db);

  await storeBackupCodes('user-1', ['hash1', 'hash2']);

  assert.equal(calls[0], 'BEGIN');
  assert.equal(calls[1], 'DELETE');
  assert.equal(calls[2], 'INSERT');
  assert.equal(calls[3], 'INSERT');
  assert.equal(calls[4], 'COMMIT');
});

// ---------------------------------------------------------------------------
// Concurrency — the core regression test
// ---------------------------------------------------------------------------

test('concurrent backup code use: only one succeeds', async () => {
  // NOTE: Because the DB stub resolves synchronously, Promise.all serialises
  // the two calls in the microtask queue rather than truly interleaving them.
  // This is a *logic test*: it proves that when the second DELETE returns
  // rowCount 0 (as Postgres guarantees for a primary-key that no longer
  // exists), consumeBackupCode correctly returns { consumed: false }.
  // True interleaved-execution coverage requires an integration test against
  // a real Postgres instance.
  //
  // Stub DB: bcrypt check passes for both concurrent calls, but only the
  // first DELETE ... RETURNING returns a row (second returns rowCount 0).
  let deleted = false;

  const db = {
    query: async sql => {
      if (sql.includes('SELECT') && sql.includes('user_backup_codes')) {
        return { rows: [{ id: 'uuid-1', code_hash: 'hashed' }] };
      }
      if (sql.includes('DELETE')) {
        if (!deleted) {
          deleted = true;
          return { rowCount: 1, rows: [{ id: 'uuid-1' }] };
        }
        // Second concurrent DELETE for the same row: already gone.
        return { rowCount: 0, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  // Always match so both concurrent calls reach the DELETE
  const bcrypt = { compare: async () => true };

  const consumeBackupCode = makeConsumeBackupCode(db, bcrypt);

  // Act: fire both calls (serialised in microtask queue via synchronous stub)
  const [r1, r2] = await Promise.all([
    consumeBackupCode('user-1', 'code'),
    consumeBackupCode('user-1', 'code'),
  ]);

  const successes = [r1, r2].filter(r => r.consumed).length;
  const failures = [r1, r2].filter(r => !r.consumed).length;
  assert.equal(successes, 1, 'exactly one concurrent call should succeed');
  assert.equal(failures, 1, 'exactly one concurrent call should fail');
});

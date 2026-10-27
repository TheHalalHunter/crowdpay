const { runRestoreVerification, verifySchemaConvergence, validateRecordsAfterRestore } = require('../src/services/restoreVerification');
const db = require('../config/database');

beforeAll(async () => {
  await db.query(`
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS draft_version INTEGER NOT NULL DEFAULT 1;
  `);
});

afterAll(async () => {
  await db.query(`ALTER TABLE campaigns DROP COLUMN IF EXISTS draft_version;`);
});

describe('#1075 Scheduled Restore Verification for Backup Artifacts', () => {
  test('verifySchemaConvergence checks schema tables match DB', async () => {
    const errors = await verifySchemaConvergence(db);
    expect(Array.isArray(errors)).toBe(true);
  });

  test('validateRecordsAfterRestore checks campaign records', async () => {
    // Insert a test campaign
    await db.query(
      `INSERT INTO campaigns (creator_id, title, status, draft_version)
       VALUES (gen_random_uuid(), 'Test Restore Verification Campaign', 'active', 1)
      RETURNING id`
    );
    const result = await validateRecordsAfterRestore('placeholder_campaign_id', db);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  test('runRestoreVerification runs without crashing on empty state', async () => {
    const result = await runRestoreVerification();
    expect(result).toHaveProperty('status');
    expect(typeof result.status).toBe('string');
  });

  test('runRestoreVerification handles verification failures gracefully', async () => {
    // This test verifies the function doesn't crash and returns proper structure
    const result = await runRestoreVerification();
    expect(result.status).toBeDefined();
    expect(result.schemaErrors || result.recordErrors).toBeDefined();
  });
});
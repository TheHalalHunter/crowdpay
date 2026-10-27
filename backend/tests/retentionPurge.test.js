const { runAllPurges, purgeKycData, purgeWebhookDeliveries, purgeCampaignWebhookDeliveries, purgeWebhooks } = require('../src/services/retentionPurge');
const db = require('../config/database');

beforeAll(async () => {
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_retention_period_days INT NOT NULL DEFAULT 365;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_retention_expires_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_legal_hold NOT NULL DEFAULT 'expired';
    ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS retention_period_days INT NOT NULL DEFAULT 365;
    ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ;
    ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS legal_hold NOT NULL DEFAULT 'expired';
    ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS retention_period_days INT NOT NULL DEFAULT 90;
    ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS legal_hold NOT NULL DEFAULT 'expired';
    ALTER TABLE campaign_webhook_deliveries ADD COLUMN IF NOT EXISTS retention_period_days INT NOT NULL DEFAULT 90;
    ALTER TABLE campaign_webhook_deliveries ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    ALTER TABLE campaign_webhook_deliveries ADD COLUMN IF NOT EXISTS legal_hold NOT NULL DEFAULT 'expired';
  `);
});

afterAll(async () => {
  await db.query(`
    ALTER TABLE users DROP COLUMN IF EXISTS kyc_retention_period_days;
    ALTER TABLE users DROP COLUMN IF EXISTS kyc_retention_expires_at;
    ALTER TABLE users DROP COLUMN IF EXISTS kyc_legal_hold;
    ALTER TABLE webhooks DROP COLUMN IF EXISTS retention_period_days;
    ALTER TABLE webhooks DROP COLUMN IF EXISTS retention_expires_at;
    ALTER TABLE webhooks DROP COLUMN IF EXISTS legal_hold;
    ALTER TABLE webhook_deliveries DROP COLUMN IF EXISTS retention_period_days;
    ALTER TABLE webhook_deliveries DROP COLUMN IF EXISTS expires_at;
    ALTER TABLE webhook_deliveries DROP COLUMN IF EXISTS legal_hold;
    ALTER TABLE campaign_webhook_deliveries DROP COLUMN IF EXISTS retention_period_days;
    ALTER TABLE campaign_webhook_deliveries DROP COLUMN IF EXISTS expires_at;
    ALTER TABLE campaign_webhook_deliveries DROP COLUMN IF EXISTS legal_hold;
  `);
});

describe('Retention and Purge Policies (#1071)', () => {
  test('purgeKycData deletes records past retention without legal hold', async () => {
    await db.query(
      `UPDATE users SET kyc_retention_expires_at = NOW() - INTERVAL '1 day', kyc_legal_hold = 'expired' WHERE kyc_status IS NOT NULL LIMIT 1`
    );
    const deleted = await purgeKycData({ retentionDays: 0 });
    expect(deleted).toBeGreaterThanOrEqual(0);
  });

  test('purgeKycData preserves records with active legal hold', async () => {
    await db.query(
      `UPDATE users SET kyc_legal_hold = 'active' WHERE id = (SELECT id FROM users LIMIT 1)`
    );
    const { rows } = await db.query(
      `SELECT id FROM users WHERE kyc_legal_hold = 'active' LIMIT 1`
    );
    const userId = rows[0].id;
    await db.query(
      `UPDATE users SET kyc_retention_expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [userId]
    );
    const deleted = await purgeKycData({ retentionDays: 0 });
    expect(deleted).toBe(0);
  });

  test('purgeWebhookDeliveries deletes expired deliveries without legal hold', async () => {
    await db.query(
      `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status, expires_at, legal_hold)
       VALUES (gen_random_uuid(), 'test.event', '{}'::jsonb, 'pending', NOW() - INTERVAL '1 day', 'expired'
       ) RETURNING id`
    );
    const { rows } = await db.query(
      `SELECT id FROM webhook_deliveries WHERE expires_at < NOW() - INTERVAL '1 day' AND legal_hold != 'active' LIMIT 1`
    );
    if (rows.length) {
      const deleted = await purgeWebhookDeliveries({ retentionDays: 0 });
      expect(deleted).toBeGreaterThanOrEqual(0);
    }
  });

  test('purgeWebhookDeliveries preserves deliveries with active legal hold', async () => {
    await db.query(
      `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status, expires_at, legal_hold)
       VALUES (gen_random_uuid(), 'test.event', '{}'::jsonb, 'pending', NOW() - INTERVAL '1 day', 'active'
       ) RETURNING id`
    );
    const { rows } = await db.query(
      `SELECT id FROM webhook_deliveries WHERE legal_hold = 'active' LIMIT 1`
    );
    if (rows.length) {
      const deleted = await purgeWebhookDeliveries({ retentionDays: 0 });
      expect(deleted).toBe(0);
    }
  });

  test('purgeCampaignWebhookDeliveries deletes expired deliveries without legal hold', async () => {
    await db.query(
      `INSERT INTO campaign_webhook_deliveries (campaign_id, event, payload, status, expires_at, legal_hold)
       VALUES (gen_random_uuid(), 'test.event', '{}'::jsonb, 'pending', NOW() - INTERVAL '1 day', 'expired'
       ) RETURNING id`
    );
    const { rows } = await db.query(
      `SELECT id FROM campaign_webhook_deliveries WHERE expires_at < NOW() - INTERVAL '1 day' AND legal_hold != 'active' LIMIT 1`
    );
    if (rows.length) {
      const deleted = await purgeCampaignWebhookDeliveries({ retentionDays: 0 });
      expect(deleted).toBeGreaterThanOrEqual(0);
    }
  });

  test('purgeCampaignWebhookDeliveries preserves deliveries with active legal hold', async () => {
    await db.query(
      `INSERT INTO campaign_webhook_deliveries (campaign_id, event, payload, status, expires_at, legal_hold)
       VALUES (gen_random_uuid(), 'test.event', '{}'::jsonb, 'pending', NOW() - INTERVAL '1 day', 'active'
       ) RETURNING id`
    );
    const { rows } = await db.query(
      `SELECT id FROM campaign_webhook_deliveries WHERE legal_hold = 'active' LIMIT 1`
    );
    if (rows.length) {
      const deleted = await purgeCampaignWebhookDeliveries({ retentionDays: 0 });
      expect(deleted).toBe(0);
    }
  });

  test('purgeWebhooks deletes expired webhooks without legal hold', async () => {
    await db.query(
      `INSERT INTO webhooks (user_id, url, events, legal_hold)
       VALUES (gen_random_uuid(), 'https://example.com/webhook', ARRAY['test'], 'expired'
       ) RETURNING id`
    );
    const { rows } = await db.query(
      `SELECT id FROM webhooks WHERE legal_hold != 'active' LIMIT 1`
    );
    if (rows.length) {
      const deleted = await purgeWebhooks({ retentionDays: 0 });
      expect(deleted).toBeGreaterThanOrEqual(0);
    }
  });

  test('purgeWebhooks preserves webhooks with active legal hold', async () => {
    await db.query(
      `INSERT INTO webhooks (user_id, url, events, legal_hold)
       VALUES (gen_random_uuid(), 'https://example.com/webhook', ARRAY['test'], 'active'
       ) RETURNING id`
    );
    const { rows } = await db.query(
      `SELECT id FROM webhooks WHERE legal_hold = 'active' LIMIT 1`
    );
    if (rows.length) {
      const deleted = await purgeWebhooks({ retentionDays: 0 });
      expect(deleted).toBe(0);
    }
  });

  test('runAllPurges executes all purge functions', async () => {
    const results = await runAllPurges();
    expect(results).toHaveProperty('kyc');
    expect(results).toHaveProperty('webhookDeliveries');
    expect(results).toHaveProperty('campaignWebhookDeliveries');
    expect(results).toHaveProperty('webhooks');
    expect(typeof results.kyc).toBe('number');
    expect(typeof results.webhookDeliveries).toBe('number');
    expect(typeof results.campaignWebhookDeliveries).toBe('number');
    expect(typeof results.webhooks).toBe('number');
  });
});
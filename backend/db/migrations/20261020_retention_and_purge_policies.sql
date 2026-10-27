-- #1071 Implement retention and purge policies for KYC and webhook data
--
-- Default retention periods:
-- - KYC data: 365 days after last activity
-- - Webhook deliveries: 90 days
-- - Campaign webhook deliveries: 90 days
-- - Webhook subscriptions: 365 days after revocation
--
-- Legal hold: a hold prevents purging of associated records with auditability.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'legal_hold_status') THEN
    CREATE TYPE legal_hold_status AS ENUM ('active', 'expired', 'released');
  END IF;
END $$;

-- Add retention_period and legal_hold to users (KYC data)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_retention_period_days INT NOT NULL DEFAULT 365,
  ADD COLUMN IF NOT EXISTS kyc_retention_expires_at TIMESTAMPTZ;

-- Add legal hold support for KYC data
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_legal_hold legal_hold_status NOT NULL DEFAULT 'expired';

-- Add retention_period and legal_hold to webhooks
ALTER TABLE webhooks
  ADD COLUMN IF NOT EXISTS retention_period_days INT NOT NULL DEFAULT 365,
  ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS legal_hold legal_hold_status NOT NULL DEFAULT 'expired';

-- Add retention and legal hold to webhook_deliveries
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS retention_period_days INT NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS legal_hold legal_hold_status NOT NULL DEFAULT 'expired';

-- Add retention and legal hold to campaign_webhook_deliveries
ALTER TABLE campaign_webhook_deliveries
  ADD COLUMN IF NOT EXISTS retention_period_days INT NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS legal_hold legal_hold_status NOT NULL DEFAULT 'expired';

-- Create index for efficient purge queries on users KYC data
CREATE INDEX IF NOT EXISTS users_kyc_retention_idx
  ON users (kyc_retention_expires_at)
  WHERE kyc_retention_expires_at IS NOT NULL AND kyc_legal_hold = 'expired';

-- Create index for efficient purge queries on webhooks
CREATE INDEX IF NOT EXISTS webhooks_retention_idx
  ON webhooks (retention_expires_at)
  WHERE retention_expires_at IS NOT NULL AND legal_hold = 'expired';

-- Create index for efficient purge queries on webhook_deliveries
CREATE INDEX IF NOT EXISTS webhook_deliveries_retention_idx
  ON webhook_deliveries (expires_at)
  WHERE expires_at IS NOT NULL AND legal_hold = 'expired';

-- Create index for efficient purge queries on campaign_webhook_deliveries
CREATE INDEX IF NOT EXISTS campaign_webhook_deliveries_retention_idx
  ON campaign_webhook_deliveries (expires_at)
  WHERE expires_at IS NOT NULL AND legal_hold = 'expired';

-- Comment documentation
COMMENT ON COLUMN users.kyc_retention_period_days IS 'Default retention period in days for KYC data (default: 365)';
COMMENT ON COLUMN users.kyc_retention_expires_at IS 'Timestamp after which KYC data may be purged';
COMMENT ON COLUMN users.kyc_legal_hold IS 'Legal hold status: active|expired|released. Prevents purging when active';
COMMENT ON COLUMN webhooks.retention_period_days IS 'Retention period in days for webhook data (default: 365)';
COMMENT ON COLUMN webhooks.retention_expires_at IS 'Timestamp after which webhook data may be purged';
COMMENT ON COLUMN webhooks.legal_hold IS 'Legal hold status: active|expired|released. Prevents purging when active';
COMMENT ON COLUMN webhook_deliveries.retention_period_days IS 'Retention period in days for webhook deliveries (default: 90)';
COMMENT ON COLUMN webhook_deliveries.expires_at IS 'Timestamp after which webhook deliveries may be purged';
COMMENT ON COLUMN webhook_deliveries.legal_hold IS 'Legal hold status: active|expired|released. Prevents purging when active';
COMMENT ON COLUMN campaign_webhook_deliveries.retention_period_days IS 'Retention period in days for campaign webhook deliveries (default: 90)';
COMMENT ON COLUMN campaign_webhook_deliveries.expires_at IS 'Timestamp after which campaign webhook deliveries may be purged';
COMMENT ON COLUMN campaign_webhook_deliveries.legal_hold IS 'Legal hold status: active|expired|released. Prevents purging when active';
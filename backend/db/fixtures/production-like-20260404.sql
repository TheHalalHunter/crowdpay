-- Committed production-like snapshot for the migration upgrade test (#1062).
-- This is the last supported pre-feature schema in which the base campaign,
-- contribution, payout, and transaction records already existed. The test
-- loads this file into a disposable database and runs every later migration.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  wallet_public_key TEXT UNIQUE NOT NULL,
  wallet_secret_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE campaigns (
  id UUID PRIMARY KEY,
  creator_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  target_amount NUMERIC(20, 7) NOT NULL,
  raised_amount NUMERIC(20, 7) NOT NULL DEFAULT 0,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('XLM', 'USDC')),
  wallet_public_key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'funded', 'closed', 'withdrawn')),
  deadline DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE contributions (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  sender_public_key TEXT NOT NULL,
  amount NUMERIC(20, 7) NOT NULL,
  asset TEXT NOT NULL,
  payment_type TEXT NOT NULL DEFAULT 'payment'
    CHECK (payment_type IN ('payment', 'path_payment_strict_receive')),
  source_amount NUMERIC(20, 7),
  source_asset TEXT,
  conversion_rate NUMERIC(30, 15),
  path JSONB,
  tx_hash TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX contributions_campaign_id_idx ON contributions (campaign_id);
CREATE INDEX contributions_tx_hash_idx ON contributions (tx_hash);

CREATE TABLE withdrawal_requests (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  requested_by UUID NOT NULL REFERENCES users(id),
  amount NUMERIC(20, 7) NOT NULL,
  destination_key TEXT NOT NULL,
  unsigned_xdr TEXT NOT NULL,
  creator_signed BOOLEAN DEFAULT FALSE,
  platform_signed BOOLEAN DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'failed', 'denied')),
  denial_reason TEXT,
  tx_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE stellar_transactions (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('contribution', 'withdrawal')),
  status TEXT NOT NULL CHECK (status IN ('pending_signatures', 'submitted', 'indexed', 'failed')),
  tx_hash TEXT UNIQUE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  withdrawal_request_id UUID REFERENCES withdrawal_requests(id),
  initiated_by_user_id UUID REFERENCES users(id),
  unsigned_xdr TEXT,
  signed_xdr TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  contribution_id UUID REFERENCES contributions(id),
  failure_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  scopes TEXT[] NOT NULL DEFAULT ARRAY['read', 'write', 'withdrawals'],
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE webhooks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT[] NOT NULL,
  secret TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY,
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'retrying')),
  response_status INT,
  response_body_snippet TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY);
INSERT INTO schema_migrations (filename) VALUES
  ('20250601000000_add_velocity_alert_threshold.sql'),
  ('20260401_users_campaigns_contributions.sql'),
  ('20260402_add_campaign_wallet_secrets.sql'),
  ('20260403_withdrawal_requests.sql'),
  ('20260404_missing_base_tables.sql');

INSERT INTO users (id, email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'fixture-creator@example.test', 'fixture-hash', 'Fixture Creator', 'GCREATORFIXTURE', 'encrypted-fixture'),
  ('00000000-0000-0000-0000-000000000002', 'fixture-contributor@example.test', 'fixture-hash', 'Fixture Contributor', 'GCONTRIBUTORFIXTURE', 'encrypted-fixture');

INSERT INTO campaigns
  (id, creator_id, title, description, target_amount, raised_amount, asset_type, wallet_public_key, status)
VALUES
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001',
   'Production-like fixture campaign', 'Must survive every schema upgrade', 1000, 125, 'XLM',
   'GCAMPAIGNFIXTURE', 'active');

INSERT INTO contributions
  (id, campaign_id, sender_public_key, amount, asset, tx_hash)
VALUES
  ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000010',
   'GCONTRIBUTORFIXTURE', 125, 'XLM', 'fixture-contribution-tx');

INSERT INTO withdrawal_requests
  (id, campaign_id, requested_by, amount, destination_key, unsigned_xdr, status)
VALUES
  ('00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000001', 50, 'GCREATORFIXTURE', 'fixture-payout-xdr', 'pending');

INSERT INTO stellar_transactions
  (id, kind, status, campaign_id, withdrawal_request_id, initiated_by_user_id, metadata)
VALUES
  ('00000000-0000-0000-0000-000000000040', 'withdrawal', 'pending_signatures',
   '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000030',
   '00000000-0000-0000-0000-000000000001', '{"fixture":true}');

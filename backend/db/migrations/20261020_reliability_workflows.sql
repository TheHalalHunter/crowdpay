-- Reliability primitives for mutation replay, webhook dead letters, and
-- resumable ledger ingestion (#1066, #1068, #1069).

ALTER TABLE stellar_transactions
  ADD COLUMN IF NOT EXISTS idempotency_actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

DROP INDEX IF EXISTS stellar_transactions_idempotency_key_idx;
CREATE UNIQUE INDEX IF NOT EXISTS stellar_transactions_actor_idempotency_idx
  ON stellar_transactions (idempotency_actor_id, idempotency_key)
  WHERE idempotency_actor_id IS NOT NULL AND idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contributions_campaign_id
  ON contributions (campaign_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  actor_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,
  key            TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'processing'
                 CHECK (status IN ('processing', 'succeeded', 'failed')),
  response_status INT,
  response_body  JSONB,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (actor_id, scope, key),
  CHECK ((status = 'processing' AND response_status IS NULL)
         OR (status IN ('succeeded', 'failed') AND response_status IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

ALTER TABLE ledger_stream_cursors
  ADD COLUMN IF NOT EXISTS last_ledger_sequence BIGINT,
  ADD COLUMN IF NOT EXISTS last_event_key TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'running',
  ADD COLUMN IF NOT EXISTS gap_detected BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE TABLE IF NOT EXISTS ledger_event_receipts (
  campaign_id       UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  event_key         TEXT NOT NULL,
  transaction_hash  TEXT,
  ledger_sequence   BIGINT,
  paging_token      TEXT,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, event_key)
);

CREATE TABLE IF NOT EXISTS ledger_stream_alerts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  alert_type         TEXT NOT NULL CHECK (alert_type IN ('gap', 'reordered')),
  expected_sequence  BIGINT,
  observed_sequence  BIGINT,
  event_key          TEXT,
  details            JSONB NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'acknowledged', 'resolved')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ledger_stream_alerts_campaign_idx
  ON ledger_stream_alerts (campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ledger_backfill_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  requested_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  from_cursor      TEXT NOT NULL,
  to_cursor        TEXT,
  max_events       INT NOT NULL CHECK (max_events BETWEEN 1 AND 10000),
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  processed_events INT NOT NULL DEFAULT 0,
  replayed_events  INT NOT NULL DEFAULT 0,
  error_message    TEXT,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ledger_backfill_requests_campaign_idx
  ON ledger_backfill_requests (campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_kind   TEXT NOT NULL CHECK (delivery_kind IN ('user', 'campaign')),
  delivery_id     UUID NOT NULL,
  attempt_number  INT NOT NULL CHECK (attempt_number > 0),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  response_status INT,
  succeeded       BOOLEAN NOT NULL DEFAULT FALSE,
  error_message   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_attempts_identity_idx
  ON webhook_delivery_attempts (delivery_kind, delivery_id, attempt_number);

CREATE TABLE IF NOT EXISTS webhook_dead_letters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_kind   TEXT NOT NULL CHECK (delivery_kind IN ('user', 'campaign')),
  delivery_id     UUID NOT NULL,
  webhook_id      UUID NOT NULL,
  event_type      TEXT NOT NULL,
  attempt_count   INT NOT NULL,
  last_error      TEXT,
  safe_metadata   JSONB NOT NULL DEFAULT '{}',
  replay_count    INT NOT NULL DEFAULT 0,
  failed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  UNIQUE (delivery_kind, delivery_id)
);
CREATE INDEX IF NOT EXISTS webhook_dead_letters_open_idx
  ON webhook_dead_letters (failed_at DESC) WHERE resolved_at IS NULL;

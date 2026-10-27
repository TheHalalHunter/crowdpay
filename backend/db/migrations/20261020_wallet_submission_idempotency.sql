-- Durable idempotency guard for signed wallet subscription submissions (#1066).

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS idempotency_actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_actor_idempotency_idx
  ON subscriptions (idempotency_actor_id, idempotency_key)
  WHERE idempotency_actor_id IS NOT NULL AND idempotency_key IS NOT NULL;

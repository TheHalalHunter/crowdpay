-- Privileged action audit trail (#1065)
-- Extends the append-only audit log with correlation/source context and
-- before/after state snapshots for campaign, payout, and dispute decisions.
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS correlation_id TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS before_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS after_state JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS audit_logs_correlation_idx ON audit_logs (correlation_id);
CREATE INDEX IF NOT EXISTS audit_logs_source_idx ON audit_logs (source);
CREATE INDEX IF NOT EXISTS audit_logs_created_action_idx ON audit_logs (created_at DESC, action);

-- Preserve the append-only contract for the extended table.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM PUBLIC;

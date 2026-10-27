-- Sanitized browser Content Security Policy violation reports (#1070)
-- Only normalized report fields are stored: URLs have query strings and
-- fragments removed, and script samples / raw request bodies are never saved.
CREATE TABLE IF NOT EXISTS csp_reports (
  id                  BIGSERIAL PRIMARY KEY,
  correlation_id      TEXT,
  document_uri        TEXT,
  blocked_uri         TEXT,
  violated_directive  TEXT,
  effective_directive TEXT,
  disposition         TEXT,
  source_file         TEXT,
  line_number         INTEGER,
  column_number       INTEGER,
  status_code         INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS csp_reports_created_idx ON csp_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS csp_reports_directive_idx ON csp_reports (effective_directive);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE csp_reports FROM PUBLIC;

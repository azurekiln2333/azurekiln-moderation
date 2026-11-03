ALTER TABLE applications ADD COLUMN name TEXT;
ALTER TABLE applications ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'));
ALTER TABLE applications ADD COLUMN updated_at TEXT;

CREATE TABLE IF NOT EXISTS app_keys (
  key_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(app_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('api', 'admin')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'grace', 'revoked')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS app_keys_app_kind ON app_keys(app_id, kind, status);
CREATE INDEX IF NOT EXISTS app_keys_expiry ON app_keys(status, expires_at);

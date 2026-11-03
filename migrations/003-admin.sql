CREATE TABLE IF NOT EXISTS admin_users (
  admin_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  username_lower TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super', 'admin', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  password_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS admin_users_role_status ON admin_users(role, status);

CREATE TABLE IF NOT EXISTS admin_sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  admin_id TEXT NOT NULL REFERENCES admin_users(admin_id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS admin_sessions_admin ON admin_sessions(admin_id, expires_at);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_login_attempts_bucket ON admin_login_attempts(bucket, created_at);
CREATE INDEX IF NOT EXISTS admin_login_attempts_retention ON admin_login_attempts(created_at);

CREATE TABLE IF NOT EXISTS setup_tokens (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS oidc_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  allowed_emails TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT 'openid email profile',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oidc_states (
  state_hash TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

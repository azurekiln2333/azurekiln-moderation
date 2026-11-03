/**
 * Idempotent DDL for the admin console, mirroring core migrations
 * `002-dynamic-config.sql` and `003-admin.sql`.
 *
 * The frozen contract (docs/proposals/dynamic-config-contract.md §2) makes the
 * core migrations the owner of these tables. This module repeats the exact
 * definitions with `IF NOT EXISTS` so the admin API can be exercised on its own
 * in unit tests while remaining a no-op once core has migrated. Keep column
 * names and shapes identical to those migrations.
 */
export const ADMIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_keys (
  key_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(app_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('api','admin')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','grace','revoked')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS app_keys_app_kind ON app_keys(app_id, kind, status);
CREATE INDEX IF NOT EXISTS app_keys_expiry ON app_keys(status, expires_at);
CREATE TABLE IF NOT EXISTS admin_users (
  admin_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  username_lower TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super','admin','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
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
  success INTEGER NOT NULL CHECK (success IN (0,1)),
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
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
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
`;

/** Adds the `applications` columns from contract §2 when an older database lacks them. */
export function ensureApplicationColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(applications)').all().map(row => row.name));
  if (!columns.has('name')) db.exec('ALTER TABLE applications ADD COLUMN name TEXT');
  if (!columns.has('status')) {
    db.exec("ALTER TABLE applications ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))");
  }
  if (!columns.has('updated_at')) db.exec('ALTER TABLE applications ADD COLUMN updated_at TEXT');
  db.exec('UPDATE applications SET updated_at = created_at WHERE updated_at IS NULL');
}

export function ensureAdminSchema(ctx) {
  ctx.db.exec(ADMIN_SCHEMA);
  ensureApplicationColumns(ctx.db);
}

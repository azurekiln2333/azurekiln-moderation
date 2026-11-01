CREATE TABLE applications (
  app_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE keywords (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(app_id),
  word TEXT NOT NULL,
  normalized TEXT NOT NULL,
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (app_id, category, normalized)
);
CREATE INDEX keywords_app_enabled ON keywords(app_id, enabled);
CREATE TABLE ip_rules (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(app_id),
  type TEXT NOT NULL CHECK (type IN ('ip','cidr','region')),
  value TEXT NOT NULL,
  reason TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (app_id, type, value)
);
CREATE INDEX ip_rules_app_enabled ON ip_rules(app_id, enabled);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(app_id),
  action TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  decision TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_events_app_time ON audit_events(app_id, created_at);
CREATE INDEX audit_events_retention ON audit_events(created_at);

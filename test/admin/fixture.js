import express from 'express';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { openDatabase, transaction, migrate } from '../../src/db.js';
import { createAudit } from '../../src/audit.js';
import { errorHandler, httpError } from '../../src/errors.js';
import { assertObject, pagination, stringField } from '../../src/validation.js';
import { initialize, registerRoutes } from '../../src/admin/index.js';
import { ensureAdminSchema } from '../../src/admin/schema.js';
import { initialize as initializeReview } from '../../src/review/index.js';
import { initialize as initializeReports } from '../../src/reports/index.js';

export const SUPER = { username: 'root.admin', password: 'correct horse battery staple' };

/**
 * Builds a context with the same surface core provides, then mounts the admin
 * router at `/admin/api` exactly as `src/app.js` does. Only the admin tables and
 * the minimal `applications`/`keywords`/`audit_events` columns are created, so
 * these tests exercise B's routes without depending on core's migration work.
 */
export async function adminFixture(t, options = {}) {
  const db = openDatabase(':memory:');
  db.exec(`
    CREATE TABLE applications (app_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE keywords (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, word TEXT NOT NULL, normalized TEXT NOT NULL,
      category TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (app_id, category, normalized)
    );
    CREATE TABLE ip_rules (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, type TEXT NOT NULL, value TEXT NOT NULL, reason TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (app_id, type, value)
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, action TEXT NOT NULL, actor_id TEXT, target_id TEXT,
      decision TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  let clockMs = Date.parse('2026-11-03T00:00:00.000Z');
  const ctx = {
    db,
    now: () => new Date(clockMs).toISOString(),
    httpError,
    assertObject,
    stringField,
    pagination,
    requireAdmin: (_req, _res, next) => next(),
    transaction: fn => transaction(db, fn),
    migrate: (namespace, migrations) => migrate(db, namespace, migrations, ctx.now),
    cleanupHandlers: new Map(),
    log: { info() {}, warn() {}, error() {} }
  };
  ctx.recordAudit = createAudit(ctx);
  ensureAdminSchema(ctx);
  // The console proxies reviews and reports, so the real modules must be present.
  initializeReview(ctx);
  initializeReports(ctx);
  initialize(ctx, options);

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.requestId = 'test-request';
    res.set('X-Request-Id', req.requestId);
    next();
  });
  const router = express.Router();
  router.use(express.json({ limit: '256kb', strict: true }));
  registerRoutes(router, ctx, { ...options, modules: [await import('../../src/review/index.js'),
    await import('../../src/reports/index.js')] });
  app.use('/admin/api', router);
  app.use((_req, _res, next) => next(httpError(404, 'not_found', 'Route not found')));
  app.use(errorHandler);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    });
    db.close();
  }
  t.after(close);

  let cookie = null;

  async function request(path, { method = 'GET', body, headers = {}, csrf = true, raw, cookies = true } = {}) {
    const sent = { ...headers };
    if (cookies && cookie) sent.cookie = cookie;
    if (csrf && csrfToken && !('x-csrf-token' in sent)) sent['x-csrf-token'] = csrfToken;
    if (body !== undefined || raw !== undefined) sent['content-type'] = 'application/json';
    const response = await fetch(baseUrl + path, {
      method,
      headers: sent,
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const entry of setCookie) {
      const pair = entry.split(';')[0];
      if (pair.startsWith('moderation_admin=')) cookie = pair;
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed, headers: response.headers, setCookie };
  }

  let csrfToken = null;

  async function login({ username = SUPER.username, password = SUPER.password } = {}) {
    const response = await request('/admin/api/session', { method: 'POST', body: { username, password }, csrf: false,
      headers: { origin: baseUrl } });
    if (response.status === 200) csrfToken = response.body.csrfToken;
    return response;
  }

  async function setupSuper({ code = 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' } = {}) {
    // Mirrors the contract's bootstrap: seed a code, redeem it, keep the session.
    const issued = ctx.admin.setupCodes.issue({ code });
    const response = await request('/admin/api/setup', {
      method: 'POST', csrf: false, headers: { origin: baseUrl },
      body: { code: issued.code, ...SUPER }
    });
    if (response.status === 201) csrfToken = response.body.csrfToken;
    return response;
  }

  /** Creates another administrator as the current super session. */
  async function createUser({ username, password, role = 'admin', displayName = null }) {
    return request('/admin/api/admins', { method: 'POST', body: { username, password, role, displayName } });
  }

  /** Creates an account, signs in as it, and restores the previous session. */
  async function sessionAs({ username, password, role }) {
    const savedCookie = cookie;
    const savedCsrf = csrfToken;
    await createUser({ username, password, role });
    cookie = null;
    csrfToken = null;
    const response = await login({ username, password });
    const result = { cookie, csrf: csrfToken, ...response };
    cookie = savedCookie;
    csrfToken = savedCsrf;
    return result;
  }

  function asAdmin(_fixture, options) {
    return sessionAs({ ...options, role: options.role ?? 'admin' });
  }

  function asViewer(_fixture, options) {
    return sessionAs({ ...options, role: 'viewer' });
  }

  return {
    ctx, db, baseUrl, request, login, setupSuper, close, createUser, asAdmin, asViewer,
    set csrf(value) { csrfToken = value; },
    get csrf() { return csrfToken; },
    set cookie(value) { cookie = value; },
    get cookie() { return cookie; },
    advance(ms) { clockMs += ms; },
    nowMs: () => clockMs
  };
}

export const sha256Hex = value => createHash('sha256').update(value).digest('hex');

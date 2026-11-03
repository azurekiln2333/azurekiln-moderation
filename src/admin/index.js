import { createOriginGuard, isWrite, verifyCsrf } from './csrf.js';import { initializeAccounts, publicUser } from './accounts.js';
import { initializeSessions } from './sessions.js';
import { initializeLimiter } from './ratelimit.js';
import { resolveGraceMs, resolveStore } from './store.js';
import { initializeSetupCodes } from './setup.js';
import { initializeOidc } from './oidc.js';
import { ensureAdminSchema } from './schema.js';
import { ensureSystemApp, recordAdminAudit } from './audit.js';
import { createTenantRouter } from './tenant.js';

const PORTAL_HOME = '/admin/';

/** Grace window for key rotation, honoring core's context option before the environment. */
function keyGraceMs(ctx, options) {
  return options.keyGraceMs ?? ctx.keyGraceMs ?? Number(process.env.MODERATION_KEY_GRACE_MS ?? 3_600_000);
}

/** Client address used for login throttling and session records. */
function clientIp(req) {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

export const SESSION_ROLES = ['super', 'admin', 'viewer'];

/**
 * Admin console backend (contract §5).
 *
 * `initialize(ctx)` builds tables-if-missing, wires the sub-domains into
 * `ctx.admin`, and registers cleanup handlers. `registerRoutes(router, ctx)`
 * mounts every `/admin/api/*` route; the caller mounts the returned router under
 * `/admin/api` behind the JSON body parser.
 */
export function initialize(ctx, options = {}) {
  ensureAdminSchema(ctx);
  ensureSystemApp(ctx);

  const accounts = initializeAccounts(ctx);
  const sessions = initializeSessions(ctx, {
    ttlMs: options.sessionTtlMs ?? ctx.sessionTtlMs,
    idleMs: options.sessionIdleMs ?? ctx.sessionIdleMs,
    insecureCookie: options.secureCookies === undefined ? undefined : !ctx.secureCookies,
    ...options
  });
  const limiter = initializeLimiter(ctx, options);
  const store = resolveStore(ctx);
  // Core installs `ctx.appStore` before initializing the console; when it is
  // absent (unit tests, partial checkouts) publish the fallback under the same
  // name so `/v1` authentication and the console agree on one store.
  if (!ctx.appStore) ctx.appStore = store;
  const setupCodes = initializeSetupCodes(ctx);
  const oidc = initializeOidc(ctx, { fetch: options.fetch });
  const sameOrigin = createOriginGuard({
    publicOrigin: options.publicOrigin ?? ctx.publicOrigin
  });

  /** Public origin used to build the OIDC redirect URI. */
  function callbackUrl(req) {
    const configured = process.env.MODERATION_PUBLIC_ORIGIN ?? ctx.publicOrigin ?? options.publicOrigin;
    if (configured) {
      return `${String(configured).replace(/\/$/, '')}/admin/api/auth/oidc/callback`;
    }
    const host = req.get('host');
    const forwarded = req.get('x-forwarded-proto');
    const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : (req.secure ? 'https' : 'http');
    return `${proto}://${host}/admin/api/auth/oidc/callback`;
  }

  function sessionFrom(req) {
    const row = sessions.resolve(req);
    if (!row) return null;
    const user = accounts.findById(row.admin_id);
    if (!user || user.status !== 'active') return null;
    return {
      sessionId: row.session_id,
      adminId: user.admin_id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      user,
      row
    };
  }

  function requireSession(roles = SESSION_ROLES) {
    return (req, _res, next) => {
      const session = sessionFrom(req);
      if (!session) throw ctx.httpError(401, 'unauthorized', 'Authentication required');
      if (!roles.includes(session.role)) throw ctx.httpError(403, 'forbidden', 'Insufficient role');
      req.adminSession = session;
      next();
    };
  }

  function requireSuper(req, _res, next) {
    requireSession(['super'])(req, _res, next);
  }

  function csrfGuard(req, _res, next) {
    if (!isWrite(req.method)) return next();
    if (!sameOrigin(req)) throw ctx.httpError(403, 'csrf_failed', 'Cross-site request rejected');
    const session = req.adminSession ?? sessionFrom(req);
    if (!session || !verifyCsrf(req, session.row)) {
      throw ctx.httpError(403, 'csrf_failed', 'CSRF token is missing or invalid');
    }
    req.adminSession = session;
    next();
  }

  function assertSameOrigin(req) {
    if (!sameOrigin(req)) throw ctx.httpError(403, 'csrf_failed', 'Cross-site request rejected');
  }

  function recordLogin({ req, session = null, username, ok, adminId = null }) {
    limiter.record({ username, ip: clientIp(req), success: ok });
    recordAdminAudit(ctx, {
      action: ok ? 'admin.login.success' : 'admin.login.failure',
      actorId: adminId,
      decision: ok ? 'accept' : 'reject',
      data: { username, ip: clientIp(req), method: session ? 'session' : 'oidc' }
    });
  }

  ctx.admin = {
    requireSession,
    requireSuper,
    sessionFrom,
    csrfGuard,
    accounts,
    sessions,
    store,
    setupCodes,
    oidc,
    limiter,
    assertSameOrigin,
    callbackUrl,
    recordLogin
  };

  // Sessions, login attempts and OIDC states age out with the shared 365 day cutoff.
  ctx.cleanupHandlers.set('admin_sessions', cutoff => sessions.cleanup(cutoff));
  ctx.cleanupHandlers.set('admin_login_attempts', cutoff => limiter.cleanup(cutoff));
  ctx.cleanupHandlers.set('admin_oidc_states', cutoff => oidc.cleanup(cutoff));

  return ctx.admin;
}

export function isInitialized(ctx) {
  return ctx.db.prepare("SELECT count(*) AS total FROM admin_users WHERE role = 'super' AND status = 'active'")
    .get().total > 0;
}

/** Meta reported by `GET /admin/api/meta`. */
export function meta() {
  return { version: process.env.MODERATION_VERSION ?? '1.0.0' };
}

export function registerRoutes(router, ctx, options = {}) {
  const admin = ctx.admin ?? initialize(ctx, options);
  const { accounts, sessions, store, setupCodes, oidc, limiter, callbackUrl } = admin;
  const write = [admin.csrfGuard];

  // Express does not parse cookies without a dependency; the console needs only
  // the single session cookie, so parse it here.
  router.use((req, _res, next) => {
    if (!req.cookies) req.cookies = parseCookieHeader(req.get('cookie'));
    next();
  });

  function sessionPayload(session) {
    return {
      admin: {
        adminId: session.user.admin_id,
        username: session.user.username,
        displayName: session.user.display_name,
        role: session.user.role,
        status: session.user.status,
        mustChangePassword: session.user.must_change_password === 1,
        lastLoginAt: session.user.last_login_at
      },
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt
    };
  }

  function startSession(res, { req, adminId, username }) {
    const issued = sessions.issue({ adminId, ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null });
    sessions.applyCookie(res, issued.token, issued.expiresAt);
    accounts.recordLogin(adminId);
    return issued;
  }

  function setupStatePayload() {
    const required = !isInitialized(ctx);
    return setupCodes.state({ required });
  }

  // ---- 5.1 authentication -------------------------------------------------

  router.get('/setup', (req, res) => {
    res.json(setupStatePayload());
  });

  router.post('/setup', (req, res) => {
    admin.assertSameOrigin(req);
    if (isInitialized(ctx)) throw ctx.httpError(409, 'already_initialized', 'An administrator already exists');
    const body = ctx.assertObject(req.body);
    const code = body.code;
    if (!setupCodes.consume(code)) {
      throw ctx.httpError(410, 'setup_code_invalid', 'The setup code is invalid, expired or already used');
    }
    const user = accounts.create({
      username: body.username,
      password: body.password,
      displayName: body.displayName ?? null,
      role: 'super',
      createdBy: null
    });
    const issued = startSession(res, { req, adminId: user.admin_id, username: user.username });
    setupCodes.invalidateAll();
    recordAdminAudit(ctx, { action: 'admin.setup', actorId: user.admin_id, targetId: user.admin_id });
    res.status(201).json({
      admin: {
        adminId: user.admin_id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        createdAt: user.created_at
      },
      csrfToken: issued.csrfToken,
      expiresAt: issued.expiresAt
    });
  });

  router.get('/auth/config', (req, res) => {
    const settings = oidc.publicSettings();
    const enabled = oidc.enabled();
    res.json({
      passwordLogin: true,
      oidc: {
        enabled,
        loginUrl: enabled ? '/admin/api/auth/oidc/start' : null,
        issuer: enabled ? settings.issuer : null
      }
    });
  });

  router.post('/session', (req, res) => {
    admin.assertSameOrigin(req);
    const body = ctx.assertObject(req.body);
    const username = ctx.stringField(body.username, 'username', { max: 64 });
    const password = ctx.stringField(body.password, 'password', { max: 200 });
    const blocked = limiter.check({ username, ip: clientIp(req) });
    if (blocked) {
      res.set('Retry-After', String(Math.ceil(blocked.retryAfterMs / 1000)));
      throw ctx.httpError(429, 'rate_limited', 'Too many failed login attempts');
    }
    const result = accounts.verify(username, password);
    if (!result || !result.matched) {
      if (result?.row) accounts.recordFailure(result.row.admin_id);
      admin.recordLogin({ req, username, ok: false, adminId: result?.row?.admin_id ?? null });
      if (result?.disabled) throw ctx.httpError(401, 'account_disabled', 'This account is disabled');
      throw ctx.httpError(401, 'invalid_credentials', 'Invalid username or password');
    }
    limiter.clearUser({ username, ip: clientIp(req) });
    const user = result.row;
    const issued = startSession(res, { req, adminId: user.admin_id, username: user.username });
    admin.recordLogin({ req, session: issued, username: user.username, ok: true, adminId: user.admin_id });
    const session = admin.sessionFrom(req) ?? {
      user, csrfToken: issued.csrfToken, expiresAt: issued.expiresAt
    };
    res.json({
      admin: sessionPayload({ ...session, user }).admin,
      csrfToken: issued.csrfToken,
      expiresAt: issued.expiresAt
    });
  });

  router.get('/session', admin.requireSession(), (req, res) => {
    res.json(sessionPayload(req.adminSession));
  });

  router.delete('/session', admin.requireSession(), ...write, (req, res) => {
    sessions.revoke(req.adminSession.sessionId);
    sessions.clearCookie(res);
    recordAdminAudit(ctx, { action: 'admin.logout', actorId: req.adminSession.adminId });
    res.json({ ok: true });
  });

  router.post('/session/password', admin.requireSession(), ...write, (req, res) => {
    const body = ctx.assertObject(req.body);
    const currentPassword = ctx.stringField(body.currentPassword, 'currentPassword', { max: 200 });
    const newPassword = ctx.stringField(body.newPassword, 'newPassword', { max: 200 });
    const result = accounts.verify(req.adminSession.username, currentPassword);
    if (!result?.matched) {
      admin.recordLogin({ req, username: req.adminSession.username, ok: false, adminId: req.adminSession.adminId });
      throw ctx.httpError(401, 'invalid_credentials', 'Current password is incorrect');
    }
    accounts.setPassword(req.adminSession.adminId, newPassword);
    sessions.revokeOthers(req.adminSession.adminId, req.adminSession.sessionId);
    recordAdminAudit(ctx, { action: 'admin.password.change', actorId: req.adminSession.adminId });
    res.json({ ok: true });
  });

  router.post('/session/revoke-all', admin.requireSession(), ...write, (req, res) => {
    sessions.revokeAdmin(req.adminSession.adminId);
    sessions.clearCookie(res);
    recordAdminAudit(ctx, { action: 'admin.session.revoke_all', actorId: req.adminSession.adminId });
    res.json({ ok: true });
  });

  // ---- OIDC ---------------------------------------------------------------

  router.get('/auth/oidc/start', async (req, res) => {
    if (!oidc.enabled()) throw ctx.httpError(404, 'not_configured', 'not_configured');
    const { authorizationUrl } = await oidc.beginAuthorization({ redirectUri: callbackUrl(req) });
    res.redirect(302, authorizationUrl);
  });

  router.get('/auth/oidc/callback', async (req, res) => {
    const encoded = req.query.state;
    const state = typeof encoded === 'string' ? encoded : '';
    const stored = oidc.consumeState(state);
    const redirect = suffix => res.redirect(302, `${PORTAL_HOME}login.html?error=${suffix}`);
    if (!stored) return redirect('oidc');
    if (typeof req.query.error === 'string') return redirect('oidc');
    const code = req.query.code;
    if (typeof code !== 'string' || code.length === 0) return redirect('oidc');
    let email;
    try {
      const result = await oidc.completeLogin({
        code,
        codeVerifier: stored.codeVerifier,
        nonce: stored.nonce,
        redirectUri: callbackUrl(req)
      });
      email = result.email;
    } catch (error) {
      recordAdminAudit(ctx, { action: 'admin.login.oidc_failed', decision: 'reject',
        data: { message: error.error ?? 'oidc_failure' } });
      return redirect('oidc');
    }
    // Local accounts are matched by username = email; super admins provision them up front.
    const user = accounts.findByUsername(email);
    if (!user || user.status !== 'active') {
      recordAdminAudit(ctx, { action: 'admin.login.oidc_failed', decision: 'reject', data: { email } });
      return redirect('oidc');
    }
    const issued = startSession(res, { req, adminId: user.admin_id, username: user.username });
    admin.recordLogin({ req, session: issued, username: user.username, ok: true, adminId: user.admin_id });
    res.redirect(302, stored.returnTo ?? PORTAL_HOME);
  });

  // ---- 5.2 applications and keys -----------------------------------------

  router.get('/apps', admin.requireSession(), (req, res) => {
    const { limit, offset } = ctx.pagination(req.query);
    const status = ctx.stringField(req.query.status, 'status', { required: false, values: ['active', 'disabled'] });
    const rows = store.listApps({ status: status ?? undefined });
    const items = rows.slice(offset, offset + limit).map(app => ({
      ...app,
      keySummary: store.keySummary(app.appId)
    }));
    res.json({ items, total: rows.length, limit, offset });
  });

  router.post('/apps', admin.requireSession(['super', 'admin']), ...write, (req, res) => {
    const body = ctx.assertObject(req.body);
    const app = store.createApp({ appId: body.appId, name: body.name });
    // The plaintext pair is returned exactly once, here.
    const keys = store.issueKeys(app.appId, { graceMs: resolveGraceMs(body.graceMs, keyGraceMs(ctx, options)) });
    recordAdminAudit(ctx, { action: 'admin.app.create', actorId: req.adminSession.adminId,
      targetId: app.appId, data: { name: app.name } });
    store.invalidateAudienceCache(app.appId);
    res.status(201).json({ app, keys: { apiKey: keys.apiKey, adminKey: keys.adminKey } });
  });

  function requireApp(appId) {
    const app = store.getApp(appId);
    if (!app) throw ctx.httpError(404, 'not_found', 'App not found');
    return app;
  }

  router.get('/apps/:appId', admin.requireSession(), (req, res) => {
    res.json(requireApp(req.params.appId));
  });

  router.patch('/apps/:appId', admin.requireSession(['super', 'admin']), ...write, (req, res) => {
    const body = ctx.assertObject(req.body);
    const patch = {};
    if (Object.hasOwn(body, 'name')) patch.name = body.name;
    if (Object.hasOwn(body, 'status')) patch.status = body.status;
    const app = store.updateApp(req.params.appId, patch);
    if (!app) throw ctx.httpError(404, 'not_found', 'App not found');
    recordAdminAudit(ctx, { action: 'admin.app.update', actorId: req.adminSession.adminId,
      targetId: app.appId, data: { name: app.name, status: app.status } });
    store.invalidateAudienceCache(app.appId);
    res.json(app);
  });

  router.delete('/apps/:appId', admin.requireSuper, ...write, (req, res) => {
    if (!store.getApp(req.params.appId)) throw ctx.httpError(404, 'not_found', 'App not found');
    const result = store.deleteApp(req.params.appId);
    if (!result) throw ctx.httpError(404, 'not_found', 'App not found');
    recordAdminAudit(ctx, { action: 'admin.app.delete', actorId: req.adminSession.adminId, targetId: req.params.appId });
    store.invalidateAudienceCache(req.params.appId);
    res.json(result);
  });

  router.get('/apps/:appId/keys', admin.requireSession(), (req, res) => {
    requireApp(req.params.appId);
    res.json({ items: store.listKeys(req.params.appId) ?? [] });
  });

  function graceFrom(body) {
    const fallback = keyGraceMs(ctx, options);
    if (!body || body.graceMs === undefined) return fallback;
    return resolveGraceMs(body.graceMs, fallback);
  }

  function mintInto(req, res, storeMethod, action) {
    const body = req.body === undefined || req.body === null ? {} : ctx.assertObject(req.body);
    const issued = store[storeMethod](req.params.appId, { graceMs: graceFrom(body) });
    if (!issued) throw ctx.httpError(404, 'not_found', 'App not found');
    recordAdminAudit(ctx, { action, actorId: req.adminSession.adminId,
      targetId: req.params.appId, data: { graceUntil: issued.graceUntil } });
    store.invalidateAudienceCache(req.params.appId);
    return issued;
  }

  router.post('/apps/:appId/keys', admin.requireSession(['super', 'admin']), ...write, (req, res) => {
    res.status(201).json(mintInto(req, res, 'issueKeys', 'admin.key.issue'));
  });

  router.post('/apps/:appId/keys/rotate', admin.requireSession(['super', 'admin']), ...write, (req, res) => {
    res.json(mintInto(req, res, 'rotateKeys', 'admin.key.rotate'));
  });

  router.post('/apps/:appId/keys/revoke', admin.requireSession(['super', 'admin']), ...write, (req, res) => {
    const body = req.body === undefined || req.body === null ? {} : ctx.assertObject(req.body);
    const reason = ctx.stringField(body.reason, 'reason', { required: false, max: 128 });
    const result = store.revokeKeys(req.params.appId, { reason });
    if (!result) throw ctx.httpError(404, 'not_found', 'App not found');
    recordAdminAudit(ctx, { action: 'admin.key.revoke', actorId: req.adminSession.adminId,
      targetId: req.params.appId, data: { reason } });
    store.invalidateAudienceCache(req.params.appId);
    res.json(result);
  });

  // ---- 5.3 tenant resources ----------------------------------------------

  const tenant = createTenantRouter(ctx, options.modules ?? []);
  // Reject unknown or reserved tenants before the shared handlers run, so every
  // per-application route reports 404 instead of an empty collection.
  function requireKnownApp(req, _res, next) {
    const appId = req.params.appId;
    if (typeof appId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(appId) || appId === '_system' ||
        !ctx.appStore.getApp(appId)) {
      throw ctx.httpError(404, 'not_found', 'App not found');
    }
    next();
  }
  router.use('/apps/:appId', admin.requireSession(), requireKnownApp, tenant);

  // ---- 5.4 admins (super only) -------------------------------------------

  router.get('/admins', admin.requireSuper, (req, res) => {
    const { limit, offset } = ctx.pagination(req.query);
    const status = ctx.stringField(req.query.status, 'status', { required: false, values: ['active', 'disabled'] });
    const role = ctx.stringField(req.query.role, 'role', { required: false, values: ['super', 'admin', 'viewer'] });
    res.json(accounts.list({ status, role, limit, offset }));
  });

  router.post('/admins', admin.requireSuper, ...write, (req, res) => {
    const body = ctx.assertObject(req.body);
    const user = accounts.create({
      username: body.username,
      password: body.password,
      displayName: body.displayName ?? null,
      role: body.role ?? 'admin',
      createdBy: req.adminSession.adminId
    });
    recordAdminAudit(ctx, { action: 'admin.user.create', actorId: req.adminSession.adminId,
      targetId: user.admin_id, data: { username: user.username, role: user.role } });
    res.status(201).json({
      adminId: user.admin_id, username: user.username, displayName: user.display_name,
      role: user.role, status: user.status, createdAt: user.created_at
    });
  });

  router.patch('/admins/:adminId', admin.requireSuper, ...write, (req, res) => {
    const body = ctx.assertObject(req.body);
    const user = accounts.updateProfile(req.params.adminId, {
      displayName: body.displayName, role: body.role, status: body.status
    });
    if (body.status === 'disabled' || body.role !== undefined) {
      // A role or status change must not leave a stale session with old rights.
      sessions.revokeAdmin(user.admin_id);
    }
    recordAdminAudit(ctx, { action: 'admin.user.update', actorId: req.adminSession.adminId,
      targetId: user.admin_id, data: { role: user.role, status: user.status } });
    res.json(publicUser(user));
  });

  router.post('/admins/:adminId/password', admin.requireSuper, ...write, (req, res) => {
    const body = ctx.assertObject(req.body);
    const mustChange = body.mustChangePassword ?? false;
    if (typeof mustChange !== 'boolean') throw ctx.httpError(400, 'invalid_request', 'mustChangePassword must be a boolean');
    accounts.setPassword(req.params.adminId, body.newPassword, { mustChangePassword: mustChange });
    sessions.revokeAdmin(req.params.adminId);
    recordAdminAudit(ctx, { action: 'admin.user.password', actorId: req.adminSession.adminId,
      targetId: req.params.adminId });
    res.json({ ok: true });
  });

  router.delete('/admins/:adminId', admin.requireSuper, ...write, (req, res) => {
    const target = accounts.findById(req.params.adminId);
    if (!target) throw ctx.httpError(404, 'not_found', 'Admin not found');
    if (target.admin_id === req.adminSession.adminId) {
      throw ctx.httpError(409, 'conflict', 'You cannot delete your own account');
    }
    if (target.role === 'super' && target.status === 'active' && accounts.countActiveSupers() <= 1) {
      throw ctx.httpError(409, 'last_super_admin', 'At least one active super administrator is required');
    }
    sessions.revokeAdmin(target.admin_id);
    accounts.remove(target.admin_id);
    recordAdminAudit(ctx, { action: 'admin.user.delete', actorId: req.adminSession.adminId, targetId: target.admin_id });
    res.json({ deleted: true });
  });

  // ---- 5.5 OIDC settings (super only) ------------------------------------

  router.get('/settings/oidc', admin.requireSuper, (req, res) => {
    res.json(oidc.publicSettings());
  });

  router.put('/settings/oidc', admin.requireSuper, ...write, async (req, res) => {
    const body = ctx.assertObject(req.body);
    const saved = await oidc.save({
      enabled: body.enabled,
      issuer: body.issuer,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      allowedEmails: body.allowedEmails,
      scopes: body.scopes,
      redirectUri: callbackUrl(req)
    });
    recordAdminAudit(ctx, { action: 'admin.oidc.update', actorId: req.adminSession.adminId,
      data: { enabled: saved.enabled, issuer: saved.issuer ?? null } });
    res.json(saved);
  });

  router.delete('/settings/oidc', admin.requireSuper, ...write, (req, res) => {
    oidc.clear();
    recordAdminAudit(ctx, { action: 'admin.oidc.delete', actorId: req.adminSession.adminId });
    res.json({ deleted: true });
  });

  // ---- 5.6 meta ----------------------------------------------------------

  router.get('/meta', admin.requireSession(), (req, res) => {
    res.json({
      ...meta(),
      setupRequired: !isInitialized(ctx),
      oidcEnabled: oidc.enabled(),
      apps: store.listApps({}).length,
      admin: {
        adminId: req.adminSession.adminId,
        username: req.adminSession.username,
        role: req.adminSession.role
      }
    });
  });

  return router;
}

export function parseCookieHeader(header) {
  const jar = Object.create(null);
  if (typeof header !== 'string' || header.length === 0) return jar;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const name = pair.slice(0, index).trim();
    if (!/^[\w.-]+$/.test(name) || name in jar) continue;
    const value = pair.slice(index + 1).trim();
    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      jar[name] = value;
    }
  }
  return jar;
}

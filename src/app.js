import express from 'express';
import { randomUUID } from 'node:crypto';
import { authenticate, requireAdmin } from './auth.js';
import { openDatabase, migrate, migrateCore, transaction } from './db.js';
import { cleanup, createAudit, registerAuditRoutes } from './audit.js';
import { errorHandler, httpError } from './errors.js';
import { assertObject, pagination, stringField } from './validation.js';
import { provisionApp } from './text/keywords.js';
import { registerTextRoutes } from './text/index.js';
import { registerIpRoutes } from './ip/index.js';
import { ensureSetupCode } from './admin-auth.js';
import { initializeConfig, importLegacyApps } from './config/index.js';

async function loadAdminModules() {
  // B owns src/admin/. The directory may be absent while branches develop in parallel.
  try {
    return [await import('./admin/index.js')];
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && /\.\/admin\/|\.\.?\/src\/admin\/|admin\\index\.js|admin\/index\.js/.test(String(error.message))) {
      return [];
    }
    throw error;
  }
}

export async function createApp(options = {}) {
  const db = openDatabase(options.dbPath ?? process.env.MODERATION_DB_PATH ?? './var/moderation.sqlite');
  let maintenance;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(maintenance);
    db.close();
  };
  try {
    const clock = options.clock ?? (() => new Date());
    const ctx = {
      db, now: () => clock().toISOString(), httpError, assertObject, stringField, pagination, requireAdmin,
      transaction: fn => transaction(db, fn),
      migrate: (namespace, migrations) => migrate(db, namespace, migrations, ctx.now),
      cleanupHandlers: new Map(), imageProvider: options.imageProvider, regionResolver: options.regionResolver,
      keyGraceMs: options.keyGraceMs, sessionTtlMs: options.sessionTtlMs, sessionIdleMs: options.sessionIdleMs,
      secureCookies: options.secureCookies, publicOrigin: options.publicOrigin, log: options.log ?? console,
      accessClock: options.accessClock
    };
    migrateCore(ctx);
    ctx.recordAudit = createAudit(ctx);
    initializeConfig(ctx);
    ctx.provisionKeywords = appId => provisionApp(ctx, appId, { seed: options.seedKeywords !== false });
    const serviceModules = options.extensionModules ?? await Promise.all([
      import('./review/index.js'), import('./image/index.js'), import('./reports/index.js')
    ]);
    for (const module of serviceModules) module.initialize(ctx);
    if (!ctx.review || typeof ctx.review.enqueue !== 'function' || typeof ctx.review.requiresReview !== 'function') {
      throw new Error('Review extension is required');
    }
    const adminModules = options.adminModules ?? await loadAdminModules();
    for (const module of adminModules) module.initialize?.(ctx);

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', false);
    app.use((req, res, next) => {
      const requested = req.get('X-Request-Id') ?? '';
      req.requestId = /^[A-Za-z0-9._-]{1,64}$/.test(requested) ? requested : randomUUID();
      res.set('X-Request-Id', req.requestId);
      res.set('Cache-Control', 'no-store');
      next();
    });
    app.get('/healthz', (_req, res) => {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok' });
    });
    const router = express.Router();
    app.use('/v1', authenticate(ctx), (req, _res, next) => {
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
        throw httpError(415, 'unsupported_media_type', 'Content-Type application/json required');
      }
      next();
    }, express.json({ limit: '256kb', strict: true }), router);
    registerTextRoutes(router, ctx);
    registerIpRoutes(router, ctx);
    registerAuditRoutes(router, ctx);
    for (const module of serviceModules) module.registerRoutes(router, ctx);

    if (adminModules.length) {
      const adminRouter = express.Router();
      adminRouter.use((req, _res, next) => {
        // A DELETE without a body is legitimate (the console uses it for deletes),
        // so only demand JSON when a payload is actually sent.
        const sendsBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
        const requiresJson = ['POST', 'PUT', 'PATCH'].includes(req.method) ||
          (req.method === 'DELETE' && sendsBody);
        if (requiresJson && !req.is('application/json')) {
          throw httpError(415, 'unsupported_media_type', 'Content-Type application/json required');
        }
        next();
      }, express.json({ limit: '256kb', strict: true }));
      for (const module of adminModules) {
        // The tenant routes under /admin/api/apps/:appId reuse the review, image, and
        // reports registrations, so the service modules are handed over as well.
        module.registerRoutes(adminRouter, ctx, { modules: serviceModules });
      }
      app.use('/admin/api', adminRouter);
      // The web console owns its own static serving and hardening headers.
      const { registerAdminUi } = await import('./admin-ui/index.js');
      registerAdminUi(app, ctx);
    }

    app.use((_req, _res, next) => next(httpError(404, 'not_found', 'Route not found')));
    app.use(errorHandler);
    ctx.cleanup = () => cleanup(ctx);
    ctx.cleanup();
    maintenance = setInterval(() => {
      try {
        ctx.appStore.expireGraceWindows();
        ctx.cleanup();
      } catch { (ctx.log ?? console).error(JSON.stringify({ event: 'moderation.maintenance_failed' })); }
    }, 3_600_000);
    maintenance.unref();
    app.locals.context = ctx;
    app.locals.close = close;

    const legacy = 'apps' in options ? options.apps : process.env.MODERATION_APPS_JSON;
    if (legacy !== undefined && legacy !== null && legacy !== '') {
      importLegacyApps(ctx, legacy, { log: ctx.log });
    }
    const setup = ensureSetupCode(ctx);
    ctx.setup = options.onSetupCode ? options.onSetupCode(setup) ?? setup : ctx.config.publishSetupCode(setup);
    return app;
  } catch (error) {
    close();
    throw error;
  }
}

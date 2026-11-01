import express from 'express';
import { randomUUID } from 'node:crypto';
import { authenticate, configureApps, requireAdmin } from './auth.js';
import { openDatabase, migrate, migrateCore, transaction } from './db.js';
import { cleanup, createAudit, registerAuditRoutes } from './audit.js';
import { errorHandler, httpError } from './errors.js';
import { assertObject, pagination, stringField } from './validation.js';
import { provisionApps } from './text/keywords.js';
import { registerTextRoutes } from './text/index.js';
import { registerIpRoutes } from './ip/index.js';

export async function createApp(options = {}) {
  const apps = configureApps(options.apps ?? process.env.MODERATION_APPS_JSON);
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
      cleanupHandlers: new Map(), imageProvider: options.imageProvider, regionResolver: options.regionResolver
    };
    migrateCore(ctx);
    ctx.recordAudit = createAudit(ctx);
    provisionApps(ctx, apps.keys(), { seed: options.seedKeywords !== false });
    const modules = options.extensionModules ?? await Promise.all([
      import('./review/index.js'), import('./image/index.js'), import('./reports/index.js')
    ]);
    for (const module of modules) module.initialize(ctx);
    if (!ctx.review || typeof ctx.review.enqueue !== 'function' || typeof ctx.review.requiresReview !== 'function') {
      throw new Error('Review extension is required');
    }
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
    app.use('/v1', authenticate(apps), (req, _res, next) => {
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
        throw httpError(415, 'unsupported_media_type', 'Content-Type application/json required');
      }
      next();
    }, express.json({ limit: '256kb', strict: true }), router);
    registerTextRoutes(router, ctx);
    registerIpRoutes(router, ctx);
    registerAuditRoutes(router, ctx);
    for (const module of modules) module.registerRoutes(router, ctx);
    app.use((_req, _res, next) => next(httpError(404, 'not_found', 'Route not found')));
    app.use(errorHandler);
    ctx.cleanup = () => cleanup(ctx);
    ctx.cleanup();
    maintenance = setInterval(() => {
      try { ctx.cleanup(); } catch { console.error(JSON.stringify({ event: 'moderation.maintenance_failed' })); }
    }, 3_600_000);
    maintenance.unref();
    app.locals.context = ctx;
    app.locals.close = close;
    return app;
  } catch (error) {
    close();
    throw error;
  }
}

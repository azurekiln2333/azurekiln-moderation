import express from 'express';
import { randomUUID } from 'node:crypto';
import { CATEGORIES, createKeywordMatcher, registerKeywordRoutes } from '../text/keywords.js';
import { registerIpRoutes } from '../ip/index.js';
import { registerAuditRoutes } from '../audit.js';
import { normalizeText } from '../text/normalize.js';
import { booleanField } from '../validation.js';

const MAX_EXPORT = 50_000;
const MAX_IMPORT = 5_000;

/**
 * Tenant-scoped admin routes (contract §5.3).
 *
 * The per-app resource semantics are identical to `/v1/admin/*`, so instead of
 * forking the handlers this builds one Express router that reuses the existing
 * registration functions with `req.auth` supplied from the URL's `:appId`.
 * The session guard has already run, so `isAdmin` is always true here.
 */
export function createTenantRouter(ctx, modules = []) {
  const router = express.Router({ mergeParams: true });
  const shared = express.Router({ mergeParams: true });

  router.use((req, _res, next) => {
    req.auth = Object.freeze({ appId: req.params.appId, isAdmin: true });
    next();
  });

  // Contract §5.0: viewers are read-only, so every state-changing tenant call
  // needs an admin or super role. The session is already resolved by the parent.
  router.use((req, _res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && req.adminSession?.role === 'viewer') {
      throw ctx.httpError(403, 'forbidden', 'Insufficient role');
    }
    next();
  });

  // Keyword import/export are admin-only additions registered before the shared
  // keyword routes so `/keywords/export` is not swallowed by `/keywords/:id`.
  router.get('/keywords/export', (req, res) => {
    const rows = ctx.db.prepare('SELECT word, category, enabled FROM keywords WHERE app_id = ? ORDER BY category, word')
      .all(req.params.appId);
    if (rows.length > MAX_EXPORT) {
      throw ctx.httpError(413, 'payload_too_large', `Export exceeds ${MAX_EXPORT} keywords`);
    }
    res.json({ items: rows.map(row => ({ word: row.word, category: row.category, enabled: row.enabled === 1 })) });
  });

  router.post('/keywords/import', (req, res) => {
    const body = ctx.assertObject(req.body);
    const mode = body.mode === undefined ? 'merge' : ctx.stringField(body.mode, 'mode', { values: ['merge', 'replace'] });
    if (!Array.isArray(body.items)) throw ctx.httpError(400, 'invalid_request', 'items must be an array');
    if (body.items.length > MAX_IMPORT) {
      throw ctx.httpError(400, 'invalid_request', `items must contain at most ${MAX_IMPORT} entries`);
    }
    const appId = req.params.appId;
    // Validate the whole batch before writing anything: one bad row rejects all.
    const prepared = body.items.map((item, index) => {
      const entry = ctx.assertObject(item, `items[${index}]`);
      const word = ctx.stringField(entry.word, `items[${index}].word`, { max: 128 });
      const normalized = normalizeText(word);
      if (!normalized) throw ctx.httpError(400, 'invalid_request', `items[${index}].word must contain letters or digits`);
      const category = ctx.stringField(entry.category, `items[${index}].category`, { values: CATEGORIES });
      const enabled = booleanField(entry.enabled, `items[${index}].enabled`, true);
      return { word, normalized, category, enabled };
    });
    const counts = { created: 0, updated: 0, skipped: 0, total: prepared.length };
    ctx.transaction(() => {
      if (mode === 'replace') {
        const categories = [...new Set(prepared.map(entry => entry.category))];
        for (const category of categories) {
          ctx.db.prepare('DELETE FROM keywords WHERE app_id = ? AND category = ?').run(appId, category);
        }
      }
      const existing = ctx.db.prepare('SELECT id, enabled FROM keywords WHERE app_id = ? AND category = ? AND normalized = ?');
      const insert = ctx.db.prepare('INSERT INTO keywords VALUES(?,?,?,?,?,?,?,?)');
      const update = ctx.db.prepare('UPDATE keywords SET word = ?, enabled = ?, updated_at = ? WHERE app_id = ? AND id = ?');
      const now = ctx.now();
      for (const entry of prepared) {
        const current = existing.get(appId, entry.category, entry.normalized);
        if (current) {
          if ((current.enabled === 1) === entry.enabled) {
            counts.skipped += 1;
          } else {
            update.run(entry.word, Number(entry.enabled), now, appId, current.id);
            counts.updated += 1;
          }
          continue;
        }
        insert.run(randomUUID(), appId, entry.word, entry.normalized, entry.category, Number(entry.enabled), now, now);
        counts.created += 1;
      }
      ctx.recordAudit({
        appId, action: 'keyword.import', targetId: null,
        data: { mode, ...counts }
      });
    });
    ctx.keywordMatcher?.invalidate(appId);
    ctx.appStore?.invalidateAudienceCache?.(appId);
    res.json(counts);
  });

  // The shared modules register under `/admin/...` for the `/v1` router. Rewrite
  // the console path so `/admin/api/apps/:appId/keywords` reaches the same
  // handler as `/v1/admin/keywords`, without duplicating any logic.
  router.use((req, _res, next) => {
    if (req.url === '/' || req.url === '') {
      req.url = '/admin';
    } else if (!req.url.startsWith('/admin')) {
      req.url = `/admin${req.url.startsWith('/') ? '' : '/'}${req.url}`;
    }
    next();
  });

  // Core publishes the matcher when the `/v1` text routes register; a partial
  // checkout (tests) may not have one yet, so fall back to a local instance.
  if (!ctx.keywordMatcher) ctx.keywordMatcher = createKeywordMatcher(ctx);

  registerKeywordRoutes(shared, ctx, ctx.keywordMatcher);
  registerIpRoutes(shared, ctx);
  registerAuditRoutes(shared, ctx);
  for (const module of modules) module.registerRoutes(shared, ctx);
  router.use(shared);
  return router;
}

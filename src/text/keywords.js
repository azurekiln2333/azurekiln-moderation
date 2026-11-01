import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeText } from './normalize.js';
import { booleanField } from '../validation.js';

export const CATEGORIES = Object.freeze([
  'politics', 'pornography', 'gambling', 'drugs', 'weapons', 'controlled_items',
  'fraud', 'terrorism', 'prohibited_goods', 'advertising', 'custom'
]);
export const KEYWORD_CACHE_MS = 60_000;

function view(row) {
  return { id: row.id, word: row.word, category: row.category, enabled: Boolean(row.enabled),
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export function provisionApps(ctx, appIds, { seed = true } = {}) {
  const entries = seed ? JSON.parse(readFileSync(new URL('../../data/seed-keywords.json', import.meta.url), 'utf8')) : [];
  ctx.transaction(() => {
    const addApp = ctx.db.prepare('INSERT OR IGNORE INTO applications VALUES(?,?)');
    const addWord = ctx.db.prepare('INSERT OR IGNORE INTO keywords VALUES(?,?,?,?,?,?,?,?)');
    for (const appId of appIds) {
      if (!addApp.run(appId, ctx.now()).changes) continue;
      for (const { word, category } of entries) {
        const normalized = normalizeText(word);
        if (normalized && CATEGORIES.includes(category)) {
          const now = ctx.now();
          addWord.run(randomUUID(), appId, word, normalized, category, 1, now, now);
        }
      }
    }
  });
}

export function createKeywordMatcher(ctx) {
  const cache = new Map();
  return {
    invalidate: appId => cache.delete(appId),
    match(appId, text) {
      const time = new Date(ctx.now()).getTime();
      let entry = cache.get(appId);
      if (!entry || time - entry.loadedAt >= KEYWORD_CACHE_MS || time < entry.loadedAt) {
        entry = { loadedAt: time, words: ctx.db.prepare('SELECT id,normalized,category FROM keywords WHERE app_id=? AND enabled=1').all(appId) };
        cache.set(appId, entry);
      }
      const normalized = normalizeText(text);
      return entry.words.filter(word => normalized.includes(word.normalized))
        .map(word => ({ keywordId: word.id, category: word.category }));
    }
  };
}

export function registerKeywordRoutes(router, ctx, matcher) {
  function validated(body, current) {
    ctx.assertObject(body);
    if (current && !['word', 'category', 'enabled'].some(key => Object.hasOwn(body, key))) {
      throw ctx.httpError(400, 'invalid_request', 'Supply a keyword field to update');
    }
    const word = ctx.stringField(Object.hasOwn(body, 'word') ? body.word : current?.word, 'word', { max: 128 });
    const normalized = normalizeText(word);
    if (!normalized) throw ctx.httpError(400, 'invalid_request', 'word must contain letters or digits');
    const category = ctx.stringField(Object.hasOwn(body, 'category') ? body.category : current?.category, 'category', { values: CATEGORIES });
    const enabled = booleanField(body.enabled, 'enabled', current ? Boolean(current.enabled) : true);
    return { word, normalized, category, enabled };
  }
  const find = (appId, id) => {
    const row = ctx.db.prepare('SELECT * FROM keywords WHERE app_id=? AND id=?').get(appId, id);
    if (!row) throw ctx.httpError(404, 'not_found', 'Keyword not found');
    return row;
  };
  router.get('/admin/keywords', ctx.requireAdmin, (req, res) => {
    const { limit, offset } = ctx.pagination(req.query);
    const category = ctx.stringField(req.query.category, 'category', { required: false, values: CATEGORIES });
    const where = category ? 'app_id=? AND category=?' : 'app_id=?';
    const params = category ? [req.auth.appId, category] : [req.auth.appId];
    const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM keywords WHERE ${where}`).get(...params).n;
    const items = ctx.db.prepare(`SELECT * FROM keywords WHERE ${where} ORDER BY created_at,id LIMIT ? OFFSET ?`).all(...params, limit, offset).map(view);
    res.json({ items, total, limit, offset });
  });
  router.post('/admin/keywords', ctx.requireAdmin, (req, res) => {
    const value = validated(req.body);
    const id = randomUUID();
    const now = ctx.now();
    ctx.transaction(() => {
      ctx.db.prepare('INSERT INTO keywords VALUES(?,?,?,?,?,?,?,?)')
        .run(id, req.auth.appId, value.word, value.normalized, value.category, Number(value.enabled), now, now);
      ctx.recordAudit({ appId: req.auth.appId, action: 'keyword.create', targetId: id, data: { category: value.category, enabled: value.enabled } });
    });
    matcher.invalidate(req.auth.appId);
    res.status(201).json(view(find(req.auth.appId, id)));
  });
  router.patch('/admin/keywords/:id', ctx.requireAdmin, (req, res) => {
    const current = find(req.auth.appId, req.params.id);
    const value = validated(req.body, current);
    ctx.transaction(() => {
      ctx.db.prepare('UPDATE keywords SET word=?,normalized=?,category=?,enabled=?,updated_at=? WHERE app_id=? AND id=?')
        .run(value.word, value.normalized, value.category, Number(value.enabled), ctx.now(), req.auth.appId, current.id);
      ctx.recordAudit({ appId: req.auth.appId, action: 'keyword.update', targetId: current.id, data: { category: value.category, enabled: value.enabled } });
    });
    matcher.invalidate(req.auth.appId);
    res.json(view(find(req.auth.appId, current.id)));
  });
  router.delete('/admin/keywords/:id', ctx.requireAdmin, (req, res) => {
    const current = find(req.auth.appId, req.params.id);
    ctx.transaction(() => {
      ctx.db.prepare('DELETE FROM keywords WHERE app_id=? AND id=?').run(req.auth.appId, current.id);
      ctx.recordAudit({ appId: req.auth.appId, action: 'keyword.delete', targetId: current.id });
    });
    matcher.invalidate(req.auth.appId);
    res.json({ deleted: true });
  });
}

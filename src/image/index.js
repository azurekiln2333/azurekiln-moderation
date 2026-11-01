import { randomUUID } from 'node:crypto';

function imageInput(ctx, value) {
  const body = ctx.assertObject(value);
  const scene = ctx.stringField(body.scene, 'scene', { max: 64 });
  const imageUrl = ctx.stringField(body.imageUrl, 'imageUrl', { max: 8192 });
  let url;
  try { url = new URL(imageUrl); } catch { throw ctx.httpError(400, 'invalid_request', 'imageUrl must be an HTTPS URL'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw ctx.httpError(400, 'invalid_request', 'imageUrl must use HTTPS without credentials');
  }
  return {
    scene,
    imageUrl,
    userId: ctx.stringField(body.userId, 'userId', { required: false }),
    targetType: ctx.stringField(body.targetType, 'targetType', { required: false }),
    targetId: ctx.stringField(body.targetId, 'targetId', { required: false }),
    metadata: body.metadata === undefined ? {} : ctx.assertObject(body.metadata, 'metadata')
  };
}

function providerResult(value) {
  if (!value || !['pass', 'block', 'review'].includes(value.decision) ||
      !Array.isArray(value.categories) || value.categories.length > 100 ||
      !value.categories.every(category => typeof category === 'string' && category.length > 0 && category.length <= 64) ||
      !Array.isArray(value.hits) || value.hits.length > 100) throw new Error('Invalid image provider result');
  // Keep provider payloads and matched text out of public responses and audits.
  const hits = value.hits.map(hit => {
    if (!hit || typeof hit !== 'object' || Array.isArray(hit)) throw new Error('Invalid image provider hit');
    const safe = {};
    for (const key of ['keywordId', 'category', 'ruleId', 'type']) {
      if (hit[key] !== undefined) {
        if (typeof hit[key] !== 'string' || hit[key].length > 128) throw new Error('Invalid image provider hit');
        safe[key] = hit[key];
      }
    }
    return safe;
  });
  return { decision: value.decision, categories: [...value.categories], hits };
}

export function initialize(ctx) {
  ctx.migrate('image', [{ version: 1, sql: `
    CREATE TABLE image_decisions (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      scene TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('pass', 'block', 'review')),
      categories_json TEXT NOT NULL,
      hits_json TEXT NOT NULL,
      review_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX image_decisions_app ON image_decisions(app_id, created_at);
    CREATE INDEX image_decisions_retention ON image_decisions(created_at);
  ` }]);
  ctx.cleanupHandlers.set('image', cutoff =>
    Number(ctx.db.prepare('DELETE FROM image_decisions WHERE created_at < ?').run(cutoff).changes));
}

export function registerRoutes(router, ctx) {
  router.post('/image/check', async (req, res) => {
    const input = imageInput(ctx, req.body);
    let checked = { decision: 'review', categories: [], hits: [] };
    let providerStatus = 'unconfigured';
    if (typeof ctx.imageProvider?.check === 'function') {
      try {
        checked = providerResult(await ctx.imageProvider.check({ appId: req.auth.appId, scene: input.scene,
          imageUrl: input.imageUrl, userId: input.userId, metadata: input.metadata }));
        providerStatus = 'ok';
      } catch {
        providerStatus = 'failed';
      }
    }
    const result = ctx.transaction(() => {
      const queued = checked.decision === 'review' ||
        (checked.decision === 'pass' && ctx.review.requiresReview(req.auth.appId, input.scene));
      const id = randomUUID();
      const createdAt = ctx.now();
      const decision = queued ? 'review' : checked.decision;
      const reviewId = queued ? ctx.review.enqueue({ appId: req.auth.appId, kind: 'image', scene: input.scene,
        payload: { imageUrl: input.imageUrl, metadata: input.metadata }, userId: input.userId,
        targetType: input.targetType, targetId: input.targetId }) : null;
      ctx.db.prepare(`INSERT INTO image_decisions
        (id, app_id, scene, decision, categories_json, hits_json, review_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, req.auth.appId, input.scene, decision, JSON.stringify(checked.categories), JSON.stringify(checked.hits), reviewId, createdAt);
      ctx.recordAudit({ appId: req.auth.appId, action: 'image.check', actorId: input.userId, targetId: id, decision,
        data: { scene: input.scene, categories: checked.categories, reviewId, providerStatus } });
      return { id, decision, categories: checked.categories, hits: checked.hits, createdAt,
        ...(reviewId ? { reviewId } : {}) };
    });
    res.json(result);
  });
}

import { randomUUID } from 'node:crypto';
import { parseIp } from '../ip/address.js';
import { createKeywordMatcher, registerKeywordRoutes } from './keywords.js';

export function registerTextRoutes(router, ctx) {
  const matcher = createKeywordMatcher(ctx);
  ctx.keywordMatcher = matcher;
  registerKeywordRoutes(router, ctx, matcher);
  router.post('/text/check', (req, res) => {
    const body = ctx.assertObject(req.body);
    const scene = ctx.stringField(body.scene, 'scene', { max: 64 });
    if (typeof body.text !== 'string' || [...body.text].length > 20_000) {
      throw ctx.httpError(400, 'invalid_request', 'text must be a string of at most 20000 characters');
    }
    const userId = ctx.stringField(body.userId, 'userId', { required: false });
    const ip = ctx.stringField(body.ip, 'ip', { required: false });
    if (ip) parseIp(ip);
    const targetType = ctx.stringField(body.targetType, 'targetType', { required: false });
    const targetId = ctx.stringField(body.targetId, 'targetId', { required: false });
    const metadata = body.metadata === undefined ? {} : ctx.assertObject(body.metadata, 'metadata');
    const hits = matcher.match(req.auth.appId, body.text);
    const categories = [...new Set(hits.map(hit => hit.category))];
    let decision = hits.length ? 'block' : 'pass';
    let reviewId;
    const id = randomUUID();
    const createdAt = ctx.now();
    ctx.transaction(() => {
      if (decision === 'pass' && ctx.review.requiresReview(req.auth.appId, scene)) {
        reviewId = ctx.review.enqueue({ appId: req.auth.appId, kind: 'text', scene,
          payload: { text: body.text, metadata }, userId, ip, targetType, targetId });
        decision = 'review';
      }
      ctx.recordAudit({ appId: req.auth.appId, action: 'text.check', actorId: userId, targetId: id,
        decision, data: { scene, categories, hits, ...(reviewId ? { reviewId } : {}) } });
    });
    res.json({ id, decision, categories, hits, createdAt, ...(reviewId ? { reviewId } : {}) });
  });
}

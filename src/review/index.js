import { randomUUID } from 'node:crypto';

const statuses = ['pending', 'approved', 'rejected'];

function item(row, full = false) {
  const result = {
    id: row.id,
    scene: row.scene,
    kind: row.kind,
    status: row.status,
    decision: row.decision,
    reason: row.reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    targetType: row.target_type,
    targetId: row.target_id
  };
  if (full) {
    Object.assign(result, {
      appId: row.app_id,
      userId: row.user_id,
      ip: row.ip,
      payload: JSON.parse(row.payload_json),
      actorId: row.actor_id
    });
  }
  return result;
}

function find(ctx, appId, id) {
  const row = ctx.db.prepare('SELECT * FROM review_items WHERE app_id = ? AND id = ?').get(appId, id);
  if (!row) throw ctx.httpError(404, 'not_found', 'Review not found');
  return row;
}

export function initialize(ctx) {
  ctx.migrate('review', [{ version: 1, sql: `
    CREATE TABLE review_policies (
      app_id TEXT NOT NULL,
      scene TEXT NOT NULL,
      pre_review INTEGER NOT NULL CHECK (pre_review IN (0, 1)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (app_id, scene)
    );
    CREATE TABLE review_items (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      scene TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('text', 'image')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      decision TEXT NOT NULL DEFAULT 'review' CHECK (decision IN ('review', 'pass', 'block')),
      payload_json TEXT NOT NULL,
      user_id TEXT,
      ip TEXT,
      target_type TEXT,
      target_id TEXT,
      reason TEXT,
      actor_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX review_items_app_status ON review_items(app_id, status, scene, created_at, id);
    CREATE INDEX review_items_retention ON review_items(updated_at);
  ` }]);

  const policy = ctx.db.prepare('SELECT pre_review FROM review_policies WHERE app_id = ? AND scene = ?');
  const insert = ctx.db.prepare(`INSERT INTO review_items
    (id, app_id, scene, kind, payload_json, user_id, ip, target_type, target_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ctx.review = {
    requiresReview(appId, scene) {
      return policy.get(appId, scene)?.pre_review === 1;
    },
    enqueue({ appId, kind, scene, payload, userId = null, ip = null, targetType = null, targetId = null }) {
      const id = randomUUID();
      const now = ctx.now();
      insert.run(id, appId, scene, kind, JSON.stringify(payload), userId, ip, targetType, targetId, now, now);
      return id;
    }
  };
  ctx.cleanupHandlers.set('review', cutoff =>
    Number(ctx.db.prepare('DELETE FROM review_items WHERE updated_at < ?').run(cutoff).changes));
}

export function registerRoutes(router, ctx) {
  router.get('/admin/scenes', ctx.requireAdmin, (req, res) => {
    const { limit, offset } = ctx.pagination(req.query);
    const items = ctx.db.prepare(`SELECT scene, pre_review, updated_at FROM review_policies
      WHERE app_id = ? ORDER BY scene LIMIT ? OFFSET ?`).all(req.auth.appId, limit, offset)
      .map(row => ({ scene: row.scene, preReview: row.pre_review === 1, updatedAt: row.updated_at }));
    const { total } = ctx.db.prepare('SELECT count(*) AS total FROM review_policies WHERE app_id = ?').get(req.auth.appId);
    res.json({ items, total, limit, offset });
  });

  router.get('/admin/scenes/:scene', ctx.requireAdmin, (req, res) => {
    const scene = ctx.stringField(req.params.scene, 'scene', { max: 64 });
    const row = ctx.db.prepare('SELECT * FROM review_policies WHERE app_id = ? AND scene = ?').get(req.auth.appId, scene);
    res.json({ scene, preReview: row?.pre_review === 1, updatedAt: row?.updated_at ?? null });
  });

  router.put('/admin/scenes/:scene', ctx.requireAdmin, (req, res) => {
    const scene = ctx.stringField(req.params.scene, 'scene', { max: 64 });
    const { preReview } = ctx.assertObject(req.body);
    if (typeof preReview !== 'boolean') throw ctx.httpError(400, 'invalid_request', 'preReview must be a boolean');
    const updatedAt = ctx.now();
    ctx.transaction(() => {
      ctx.db.prepare(`INSERT INTO review_policies(app_id, scene, pre_review, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(app_id, scene) DO UPDATE SET pre_review = excluded.pre_review, updated_at = excluded.updated_at`)
        .run(req.auth.appId, scene, Number(preReview), updatedAt);
      ctx.recordAudit({ appId: req.auth.appId, action: 'review.policy', targetId: scene, data: { scene, preReview } });
    });
    res.json({ scene, preReview, updatedAt });
  });

  router.get('/admin/reviews', ctx.requireAdmin, (req, res) => {
    const { limit, offset } = ctx.pagination(req.query);
    const status = ctx.stringField(req.query.status, 'status', { required: false, values: statuses });
    const scene = ctx.stringField(req.query.scene, 'scene', { required: false, max: 64 });
    const clauses = ['app_id = ?'];
    const args = [req.auth.appId];
    if (status !== null) { clauses.push('status = ?'); args.push(status); }
    if (scene !== null) { clauses.push('scene = ?'); args.push(scene); }
    const where = clauses.join(' AND ');
    const { total } = ctx.db.prepare(`SELECT count(*) AS total FROM review_items WHERE ${where}`).get(...args);
    const items = ctx.db.prepare(`SELECT * FROM review_items WHERE ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(row => item(row, true));
    res.json({ items, total, limit, offset });
  });

  router.get('/admin/reviews/:id', ctx.requireAdmin, (req, res) => {
    res.json(item(find(ctx, req.auth.appId, req.params.id), true));
  });

  router.get('/reviews/:id', (req, res) => {
    res.json(item(find(ctx, req.auth.appId, req.params.id)));
  });

  router.post('/admin/reviews/:id/resolve', ctx.requireAdmin, (req, res) => {
    const body = ctx.assertObject(req.body);
    const decision = ctx.stringField(body.decision, 'decision', { values: ['pass', 'block'] });
    const reason = ctx.stringField(body.reason, 'reason', { max: 1000 });
    const actorId = ctx.stringField(body.actorId, 'actorId');
    const result = ctx.transaction(() => {
      const row = find(ctx, req.auth.appId, req.params.id);
      if (row.status !== 'pending') {
        if (row.decision !== decision) throw ctx.httpError(409, 'conflict', 'Review already resolved');
        return item(row, true);
      }
      const now = ctx.now();
      ctx.db.prepare(`UPDATE review_items SET status = ?, decision = ?, reason = ?, actor_id = ?,
        updated_at = ?, resolved_at = ? WHERE app_id = ? AND id = ?`)
        .run(decision === 'pass' ? 'approved' : 'rejected', decision, reason, actorId, now, now, req.auth.appId, row.id);
      ctx.recordAudit({ appId: req.auth.appId, action: 'review.resolve', actorId, targetId: row.id, decision,
        data: { scene: row.scene, kind: row.kind } });
      return item(find(ctx, req.auth.appId, row.id), true);
    });
    res.json(result);
  });
}

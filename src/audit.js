import { randomUUID } from 'node:crypto';

export const RETENTION_DAYS = 365;
const DAY_MS = 86_400_000;

export function createAudit(ctx) {
  const insert = ctx.db.prepare(`INSERT INTO audit_events
    (id,app_id,action,actor_id,target_id,decision,data,created_at) VALUES(?,?,?,?,?,?,?,?)`);
  return ({ appId, action, actorId = null, targetId = null, decision = null, data = {} }) => {
    const id = randomUUID();
    insert.run(id, appId, action, actorId, targetId, decision, JSON.stringify(data), ctx.now());
    return id;
  };
}

export function cleanup(ctx) {
  const cutoff = new Date(new Date(ctx.now()).getTime() - RETENTION_DAYS * DAY_MS).toISOString();
  return ctx.transaction(() => {
    const deleted = { audit: Number(ctx.db.prepare('DELETE FROM audit_events WHERE created_at < ?').run(cutoff).changes) };
    for (const [name, handler] of ctx.cleanupHandlers) deleted[name] = handler(cutoff);
    return deleted;
  });
}

export function registerAuditRoutes(router, ctx) {
  router.get('/admin/audit', ctx.requireAdmin, (req, res) => {
    const { limit, offset } = ctx.pagination(req.query);
    const action = ctx.stringField(req.query.action, 'action', { required: false, max: 64 });
    const params = [req.auth.appId];
    const where = action ? 'app_id=? AND action=?' : 'app_id=?';
    if (action) params.push(action);
    const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE ${where}`).get(...params).n;
    const items = ctx.db.prepare(`SELECT * FROM audit_events WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset).map(row => ({
        id: row.id, appId: row.app_id, action: row.action, actorId: row.actor_id,
        targetId: row.target_id, decision: row.decision, data: JSON.parse(row.data), createdAt: row.created_at
      }));
    res.json({ items, total, limit, offset });
  });
}

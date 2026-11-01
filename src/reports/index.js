import { randomUUID } from 'node:crypto';

function report(row) {
  return { id: row.id, targetType: row.target_type, targetId: row.target_id, reporterId: row.reporter_id,
    reason: row.reason, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

function find(ctx, appId, id) {
  const row = ctx.db.prepare('SELECT * FROM reports WHERE app_id = ? AND id = ?').get(appId, id);
  if (!row) throw ctx.httpError(404, 'not_found', 'Report not found');
  return row;
}

function detail(ctx, appId, id) {
  const row = find(ctx, appId, id);
  const history = ctx.db.prepare(`SELECT * FROM report_events WHERE app_id = ? AND report_id = ?
    ORDER BY sequence`).all(appId, id).map(event => ({ id: event.id, status: event.status, result: event.result,
    actorId: event.actor_id, createdAt: event.created_at }));
  return { ...report(row), history };
}

export function initialize(ctx) {
  ctx.migrate('reports', [{ version: 1, sql: `
    CREATE TABLE reports (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reporter_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'resolved', 'rejected')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (app_id, id)
    );
    CREATE TABLE report_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      app_id TEXT NOT NULL,
      report_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'resolved', 'rejected')),
      result TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (app_id, report_id) REFERENCES reports(app_id, id) ON DELETE CASCADE
    );
    CREATE INDEX reports_app_status ON reports(app_id, status, created_at, id);
    CREATE INDEX reports_retention ON reports(updated_at);
    CREATE INDEX report_events_parent ON report_events(app_id, report_id, sequence);
  ` }]);
  ctx.cleanupHandlers.set('reports', cutoff =>
    Number(ctx.db.prepare('DELETE FROM reports WHERE updated_at < ?').run(cutoff).changes));
}

export function registerRoutes(router, ctx) {
  router.post('/reports', (req, res) => {
    const body = ctx.assertObject(req.body);
    const targetType = ctx.stringField(body.targetType, 'targetType');
    const targetId = ctx.stringField(body.targetId, 'targetId');
    const reporterId = ctx.stringField(body.reporterId, 'reporterId');
    const reason = ctx.stringField(body.reason, 'reason', { max: 2000 });
    const id = randomUUID();
    const createdAt = ctx.now();
    ctx.transaction(() => {
      ctx.db.prepare(`INSERT INTO reports
        (id, app_id, target_type, target_id, reporter_id, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, req.auth.appId, targetType, targetId, reporterId, reason, createdAt, createdAt);
      ctx.recordAudit({ appId: req.auth.appId, action: 'report.submit', actorId: reporterId, targetId: id,
        data: { targetType, targetId } });
    });
    res.status(201).json({ id, status: 'open', createdAt });
  });

  router.get('/admin/reports', ctx.requireAdmin, (req, res) => {
    const { limit, offset } = ctx.pagination(req.query);
    const status = ctx.stringField(req.query.status, 'status', { required: false,
      values: ['open', 'accepted', 'resolved', 'rejected'] });
    const where = status === null ? 'app_id = ?' : 'app_id = ? AND status = ?';
    const args = status === null ? [req.auth.appId] : [req.auth.appId, status];
    const { total } = ctx.db.prepare(`SELECT count(*) AS total FROM reports WHERE ${where}`).get(...args);
    const items = ctx.db.prepare(`SELECT * FROM reports WHERE ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(report);
    res.json({ items, total, limit, offset });
  });

  router.get('/admin/reports/:id', ctx.requireAdmin, (req, res) => {
    res.json(detail(ctx, req.auth.appId, req.params.id));
  });

  router.post('/admin/reports/:id/handle', ctx.requireAdmin, (req, res) => {
    const body = ctx.assertObject(req.body);
    const status = ctx.stringField(body.status, 'status', { values: ['accepted', 'resolved', 'rejected'] });
    const result = ctx.stringField(body.result, 'result', { max: 2000 });
    const actorId = ctx.stringField(body.actorId, 'actorId');
    const value = ctx.transaction(() => {
      const row = find(ctx, req.auth.appId, req.params.id);
      if (row.status === 'resolved' || row.status === 'rejected') {
        const existing = detail(ctx, req.auth.appId, row.id);
        const last = existing.history.at(-1);
        if (row.status !== status || last?.result !== result || last?.actorId !== actorId) {
          throw ctx.httpError(409, 'conflict', 'Report already finalized');
        }
        return existing;
      }
      const now = ctx.now();
      ctx.db.prepare('UPDATE reports SET status = ?, updated_at = ? WHERE app_id = ? AND id = ?')
        .run(status, now, req.auth.appId, row.id);
      ctx.db.prepare(`INSERT INTO report_events
        (id, app_id, report_id, status, result, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), req.auth.appId, row.id, status, result, actorId, now);
      ctx.recordAudit({ appId: req.auth.appId, action: 'report.handle', actorId, targetId: row.id, data: { status } });
      return detail(ctx, req.auth.appId, row.id);
    });
    res.json(value);
  });
}

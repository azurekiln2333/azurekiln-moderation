export const SYSTEM_APP_ID = '_system';

/**
 * Admin console mutations are audited like tenant writes, but they belong to no
 * tenant: contract §5.0 pins `app_id` to `_system` and prefixes the actor.
 * `_system` must exist in `applications` because `audit_events.app_id` is a
 * foreign key; it is inserted disabled so no credential can ever present it.
 */
export function ensureSystemApp(ctx) {
  const existing = ctx.db.prepare('SELECT app_id FROM applications WHERE app_id = ?').get(SYSTEM_APP_ID);
  if (existing) {
    ctx.db.prepare("UPDATE applications SET status = 'disabled', updated_at = ? WHERE app_id = ? AND status <> 'disabled'")
      .run(ctx.now(), SYSTEM_APP_ID);
    return;
  }
  const now = ctx.now();
  ctx.db.prepare(`INSERT INTO applications (app_id, name, status, created_at, updated_at)
    VALUES (?, ?, 'disabled', ?, ?)`).run(SYSTEM_APP_ID, 'System', now, now);
}

export function adminActor(adminId) {
  return adminId ? `admin:${adminId}` : null;
}

export function recordAdminAudit(ctx, { action, actorId = null, targetId = null, decision = null, data = {} }) {
  return ctx.recordAudit({
    appId: SYSTEM_APP_ID,
    action,
    actorId: adminActor(actorId),
    targetId,
    decision,
    data
  });
}

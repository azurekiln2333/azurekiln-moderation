import { randomUUID } from 'node:crypto';
import { booleanField } from '../validation.js';
import { canonicalRule, matchesRule, parseIp } from './address.js';

const TYPES = ['ip', 'cidr', 'region'];
const view = row => ({ id: row.id, type: row.type, value: row.value, reason: row.reason,
  enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at });

export function registerIpRoutes(router, ctx) {
  const find = (appId, id) => {
    const row = ctx.db.prepare('SELECT * FROM ip_rules WHERE app_id=? AND id=?').get(appId, id);
    if (!row) throw ctx.httpError(404, 'not_found', 'IP rule not found');
    return row;
  };
  function validated(body, current) {
    ctx.assertObject(body);
    if (current && !['type', 'value', 'reason', 'enabled'].some(key => Object.hasOwn(body, key))) {
      throw ctx.httpError(400, 'invalid_request', 'Supply an IP rule field to update');
    }
    const type = ctx.stringField(Object.hasOwn(body, 'type') ? body.type : current?.type, 'type', { values: TYPES });
    const raw = ctx.stringField(Object.hasOwn(body, 'value') ? body.value : current?.value, 'value');
    const value = canonicalRule(type, raw);
    const reason = ctx.stringField(body.reason === undefined ? current?.reason : body.reason, 'reason', { required: false, max: 500 });
    const enabled = booleanField(body.enabled, 'enabled', current ? Boolean(current.enabled) : true);
    return { type, value, reason, enabled };
  }
  router.get('/admin/ip-rules', ctx.requireAdmin, (req, res) => {
    const { limit, offset } = ctx.pagination(req.query);
    const total = ctx.db.prepare('SELECT COUNT(*) AS n FROM ip_rules WHERE app_id=?').get(req.auth.appId).n;
    const items = ctx.db.prepare('SELECT * FROM ip_rules WHERE app_id=? ORDER BY created_at,id LIMIT ? OFFSET ?')
      .all(req.auth.appId, limit, offset).map(view);
    res.json({ items, total, limit, offset });
  });
  router.post('/admin/ip-rules', ctx.requireAdmin, (req, res) => {
    const value = validated(req.body);
    const id = randomUUID();
    const now = ctx.now();
    ctx.transaction(() => {
      ctx.db.prepare('INSERT INTO ip_rules VALUES(?,?,?,?,?,?,?,?)')
        .run(id, req.auth.appId, value.type, value.value, value.reason, Number(value.enabled), now, now);
      ctx.recordAudit({ appId: req.auth.appId, action: 'ip_rule.create', targetId: id, data: { type: value.type, enabled: value.enabled } });
    });
    res.status(201).json(view(find(req.auth.appId, id)));
  });
  router.patch('/admin/ip-rules/:id', ctx.requireAdmin, (req, res) => {
    const current = find(req.auth.appId, req.params.id);
    const value = validated(req.body, current);
    ctx.transaction(() => {
      ctx.db.prepare('UPDATE ip_rules SET type=?,value=?,reason=?,enabled=?,updated_at=? WHERE app_id=? AND id=?')
        .run(value.type, value.value, value.reason, Number(value.enabled), ctx.now(), req.auth.appId, current.id);
      ctx.recordAudit({ appId: req.auth.appId, action: 'ip_rule.update', targetId: current.id, data: { type: value.type, enabled: value.enabled } });
    });
    res.json(view(find(req.auth.appId, current.id)));
  });
  router.delete('/admin/ip-rules/:id', ctx.requireAdmin, (req, res) => {
    const current = find(req.auth.appId, req.params.id);
    ctx.transaction(() => {
      ctx.db.prepare('DELETE FROM ip_rules WHERE app_id=? AND id=?').run(req.auth.appId, current.id);
      ctx.recordAudit({ appId: req.auth.appId, action: 'ip_rule.delete', targetId: current.id });
    });
    res.json({ deleted: true });
  });
  router.post('/ip/check', async (req, res) => {
    const body = ctx.assertObject(req.body);
    const scene = ctx.stringField(body.scene, 'scene', { max: 64 });
    const ip = ctx.stringField(body.ip, 'ip');
    const address = parseIp(ip);
    const userId = ctx.stringField(body.userId, 'userId', { required: false });
    const rules = ctx.db.prepare('SELECT id,type,value FROM ip_rules WHERE app_id=? AND enabled=1').all(req.auth.appId);
    const hits = rules.filter(rule => matchesRule(address, rule)).map(rule => ({ ruleId: rule.id, type: rule.type }));
    const regionRules = rules.filter(rule => rule.type === 'region');
    if (regionRules.length && !hits.length) {
      let region = null;
      try {
        region = ctx.regionResolver ? await ctx.regionResolver(ip) : null;
      } catch {
        // Resolver errors are an unavailable dependency, never an implicit allow.
      }
      if (typeof region !== 'string' || !/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(region)) {
        ctx.recordAudit({ appId: req.auth.appId, action: 'ip.unavailable', actorId: userId, data: { scene } });
        throw ctx.httpError(503, 'moderation_unavailable', 'Region resolution unavailable');
      }
      hits.push(...regionRules.filter(rule => region === rule.value || region.startsWith(`${rule.value}-`))
        .map(rule => ({ ruleId: rule.id, type: rule.type })));
    }
    const decision = hits.length ? 'block' : 'pass';
    const categories = hits.length ? ['ip_restricted'] : [];
    const id = randomUUID();
    const createdAt = ctx.now();
    ctx.recordAudit({ appId: req.auth.appId, action: 'ip.check', actorId: userId, targetId: id,
      decision, data: { scene, categories, hits } });
    res.json({ id, decision, categories, hits, createdAt });
  });
}

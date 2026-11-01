import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../../src/app.js';
import * as review from '../../src/review/index.js';
import * as image from '../../src/image/index.js';
import * as reports from '../../src/reports/index.js';
import { ModerationClient } from '../../packages/client/index.js';

const apps = [
  { appId: 'alpha', apiKey: 'a'.repeat(32), adminKey: 'b'.repeat(32) },
  { appId: 'beta', apiKey: 'c'.repeat(32), adminKey: 'd'.repeat(32) }
];
const imageBody = { scene: 'avatar', imageUrl: 'https://app.example.cn/avatar/42.png',
  userId: '42', targetType: 'user', targetId: '42', metadata: { private: 'payload-secret' } };
const reportBody = { targetType: 'post', targetId: '7', reporterId: '42', reason: 'report-private-reason' };
const resolution = { decision: 'pass', reason: 'Checked by administrator', actorId: 'admin-1' };

async function fixture(t, options = {}) {
  let current = new Date(options.now ?? '2026-11-02T00:00:00.000Z');
  const app = await createApp({ apps, dbPath: ':memory:', seedKeywords: false, ...options, clock: () => current });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    app.locals.close();
  }
  t.after(close);
  return {
    ctx: app.locals.context,
    app,
    baseUrl,
    close,
    setTime(value) { current = new Date(value); },
    async request(path, { method = 'GET', body, admin = false, tenant = 0 } = {}) {
      const selected = apps[tenant];
      const response = await fetch(`${baseUrl}/v1${path}`, { method, headers: {
        'Content-Type': 'application/json', 'X-App-Id': selected.appId,
        Authorization: `Bearer ${admin ? selected.adminKey : selected.apiKey}`
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }
  };
}

test('module initialization and route registration are synchronous and migrations are repeatable', async t => {
  const f = await fixture(t);
  for (const module of [review, image, reports]) {
    assert.equal(module.initialize(f.ctx), undefined);
    assert.notEqual(module.registerRoutes.constructor.name, 'AsyncFunction');
  }
  assert.equal(f.ctx.review.requiresReview('alpha', 'post'), false);
  const id = f.ctx.review.enqueue({ appId: 'alpha', kind: 'text', scene: 'post', payload: { text: 'private' } });
  assert.equal(typeof id, 'string');
  assert.equal((await f.request(`/reviews/${id}`)).body.decision, 'review');
});

test('scene policy queues text immediately and public review results omit private fields', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/admin/scenes/post', { admin: true })).body,
    { scene: 'post', preReview: false, updatedAt: null });
  assert.equal((await f.request('/admin/scenes/post', { method: 'PUT', body: { preReview: true } })).status, 403);
  assert.equal((await f.request('/admin/scenes/post', { method: 'PUT', admin: true, body: { preReview: 'yes' } })).status, 400);
  assert.equal((await f.request('/admin/scenes/post', { method: 'PUT', admin: true, body: { preReview: true } })).status, 200);
  const checked = await f.request('/text/check', { method: 'POST', body: {
    scene: 'post', text: 'text-private-payload', userId: '42', ip: '192.0.2.1', targetType: 'post', targetId: '7'
  } });
  assert.equal(checked.body.decision, 'review');
  const id = checked.body.reviewId;
  const publicItem = await f.request(`/reviews/${id}`);
  assert.equal(publicItem.body.decision, 'review');
  assert.equal(publicItem.body.resolvedAt, null);
  for (const key of ['payload', 'appId', 'userId', 'ip', 'actorId']) assert.equal(key in publicItem.body, false);
  const full = await f.request(`/admin/reviews/${id}`, { admin: true });
  assert.equal(full.body.payload.text, 'text-private-payload');
  assert.equal(full.body.userId, '42');
  assert.equal((await f.request('/admin/reviews?status=pending&scene=post', { admin: true })).body.total, 1);
  assert.equal((await f.request('/admin/scenes', { admin: true, tenant: 1 })).body.total, 0);
  assert.equal((await f.request('/text/check', { method: 'POST', tenant: 1, body: { scene: 'post', text: 'hello' } })).body.decision, 'pass');
  assert.equal((await f.request(`/reviews/${id}`, { tenant: 1 })).status, 404);
  assert.equal((await f.request(`/admin/reviews/${id}`, { admin: true, tenant: 1 })).status, 404);
  assert.equal((await f.request(`/admin/reviews/${id}/resolve`, { method: 'POST', admin: true, tenant: 1, body: resolution })).status, 404);
  assert.equal((await f.request('/admin/scenes/post', { method: 'PUT', admin: true, body: { preReview: false } })).status, 200);
  assert.equal((await f.request('/text/check', { method: 'POST', body: { scene: 'post', text: 'hello' } })).body.decision, 'pass');
});

test('review resolution is final, audited, and idempotent', async t => {
  const f = await fixture(t);
  const checked = await f.request('/image/check', { method: 'POST', body: imageBody });
  const id = checked.body.reviewId;
  assert.equal((await f.request(`/admin/reviews/${id}/resolve`, { method: 'POST', body: resolution })).status, 403);
  assert.equal((await f.request(`/admin/reviews/${id}/resolve`, { method: 'POST', admin: true,
    body: { ...resolution, reason: '' } })).status, 400);
  const resolved = await f.request(`/admin/reviews/${id}/resolve`, { method: 'POST', admin: true, body: resolution });
  assert.equal(resolved.body.status, 'approved');
  assert.equal(resolved.body.actorId, 'admin-1');
  assert.equal((await f.request(`/reviews/${id}`)).body.decision, 'pass');
  f.setTime('2026-11-03T00:00:00.000Z');
  const repeated = await f.request(`/admin/reviews/${id}/resolve`, { method: 'POST', admin: true, body: resolution });
  assert.deepEqual(repeated.body, resolved.body);
  assert.equal((await f.request('/admin/audit?action=review.resolve', { admin: true })).body.total, 1);
  assert.equal((await f.request(`/admin/reviews/${id}/resolve`, { method: 'POST', admin: true,
    body: { ...resolution, decision: 'block' } })).status, 409);
  const next = (await f.request('/image/check', { method: 'POST', body: imageBody })).body.reviewId;
  const rejected = await f.request(`/admin/reviews/${next}/resolve`, { method: 'POST', admin: true,
    body: { ...resolution, decision: 'block' } });
  assert.equal(rejected.body.status, 'rejected');
  assert.equal((await f.request(`/reviews/${next}`)).body.decision, 'block');
});

test('images without a provider queue and validate HTTPS references without fetching them', async t => {
  const f = await fixture(t);
  const response = await f.request('/image/check', { method: 'POST', body: { ...imageBody, appId: 'beta' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.decision, 'review');
  assert.equal((await f.request(`/admin/reviews/${response.body.reviewId}`, { admin: true })).body.appId, 'alpha');
  for (const imageUrl of ['http://example.cn/a', 'ftp://example.cn/a', 'https://user:secret@example.cn/a', 'not-a-url']) {
    assert.equal((await f.request('/image/check', { method: 'POST', body: { ...imageBody, imageUrl } })).status, 400);
  }
  for (const extra of [{ metadata: [] }, { scene: 'x'.repeat(65) }, { userId: 42 }, { imageUrl: '' }]) {
    assert.equal((await f.request('/image/check', { method: 'POST', body: { ...imageBody, ...extra } })).status, 400);
  }
  assert.equal((await f.request('/admin/reviews', { admin: true })).body.total, 1);
});

test('image providers pass, block, queue, and fail safely while pre-review overrides only pass', async t => {
  let result = { decision: 'pass', categories: [], hits: [] };
  let called;
  const f = await fixture(t, { imageProvider: { async check(input) {
    called = input;
    if (result instanceof Error) throw result;
    return result;
  } } });
  assert.equal((await f.request('/image/check', { method: 'POST', body: imageBody })).body.decision, 'pass');
  assert.equal(called.appId, 'alpha');
  assert.equal(called.imageUrl, imageBody.imageUrl);
  await f.request('/admin/scenes/avatar', { method: 'PUT', admin: true, body: { preReview: true } });
  assert.equal((await f.request('/image/check', { method: 'POST', body: imageBody })).body.decision, 'review');
  result = { decision: 'block', categories: ['pornography'], hits: [{ category: 'pornography', word: 'provider-private-word' }] };
  const blocked = await f.request('/image/check', { method: 'POST', body: imageBody });
  assert.equal(blocked.body.decision, 'block');
  assert.equal(blocked.body.reviewId, undefined);
  assert.deepEqual(blocked.body.hits, [{ category: 'pornography' }]);
  for (const value of [new Error('provider-private-token'), { decision: 'allow' },
    { decision: 'pass', categories: 'invalid', hits: [] }, { decision: 'review', categories: [], hits: [] }]) {
    result = value;
    assert.equal((await f.request('/image/check', { method: 'POST', body: imageBody })).body.decision, 'review');
  }
  const audit = JSON.stringify((await f.request('/admin/audit?action=image.check', { admin: true })).body);
  for (const secret of ['payload-secret', imageBody.imageUrl, 'provider-private-token', 'provider-private-word']) {
    assert.equal(audit.includes(secret), false);
  }
  assert.equal((await f.request('/admin/reviews', { admin: true })).body.total, 5);
});

test('reports retain handling history, enforce final states, and isolate apps', async t => {
  const f = await fixture(t);
  const submitted = await f.request('/reports', { method: 'POST', body: { ...reportBody, appId: 'beta' } });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.body.status, 'open');
  const id = submitted.body.id;
  assert.equal((await f.request('/admin/reports')).status, 403);
  assert.equal((await f.request('/admin/reports?status=open', { admin: true })).body.total, 1);
  assert.equal((await f.request('/admin/reports', { admin: true, tenant: 1 })).body.total, 0);
  assert.equal((await f.request(`/admin/reports/${id}`, { admin: true, tenant: 1 })).status, 404);
  assert.equal((await f.request(`/admin/reports/${id}/handle`, { method: 'POST', admin: true, tenant: 1,
    body: { status: 'accepted', result: 'Investigating', actorId: 'admin-1' } })).status, 404);
  const accepted = await f.request(`/admin/reports/${id}/handle`, { method: 'POST', admin: true,
    body: { status: 'accepted', result: 'Investigating', actorId: 'admin-1' } });
  assert.equal(accepted.body.history.length, 1);
  const body = { status: 'resolved', result: 'Removed by application administrator', actorId: 'admin-1' };
  const resolved = await f.request(`/admin/reports/${id}/handle`, { method: 'POST', admin: true, body });
  assert.deepEqual(resolved.body.history.map(event => event.status), ['accepted', 'resolved']);
  assert.deepEqual((await f.request(`/admin/reports/${id}/handle`, { method: 'POST', admin: true, body })).body, resolved.body);
  for (const extra of [{ result: 'Changed final outcome' }, { actorId: 'other-admin' }]) {
    assert.equal((await f.request(`/admin/reports/${id}/handle`, { method: 'POST', admin: true,
      body: { ...body, ...extra } })).status, 409);
  }
  for (const status of ['accepted', 'rejected']) {
    assert.equal((await f.request(`/admin/reports/${id}/handle`, { method: 'POST', admin: true,
      body: { ...body, status } })).status, 409);
  }
  assert.equal((await f.request(`/admin/reports/${id}/handle`, { method: 'POST', admin: true,
    body: { ...body, status: 'open' } })).status, 400);
  assert.equal((await f.request('/admin/audit?action=report.handle', { admin: true })).body.total, 2);
  const audit = JSON.stringify((await f.request('/admin/audit', { admin: true })).body);
  assert.equal(audit.includes(reportBody.reason), false);
  assert.equal(audit.includes(body.result), false);
  const next = (await f.request('/reports', { method: 'POST', body: reportBody })).body.id;
  const rejected = await f.request(`/admin/reports/${next}/handle`, { method: 'POST', admin: true,
    body: { ...body, status: 'rejected' } });
  assert.equal(rejected.body.status, 'rejected');
  assert.equal(rejected.body.history.length, 1);
});

test('report and list validation rejects malformed fields and pagination', async t => {
  const f = await fixture(t);
  for (const extra of [{ targetType: '' }, { targetId: 1 }, { reporterId: null }, { reason: 'x'.repeat(2001) }]) {
    assert.equal((await f.request('/reports', { method: 'POST', body: { ...reportBody, ...extra } })).status, 400);
  }
  assert.equal((await f.request('/reports', { method: 'POST', body: { ...reportBody, reason: '😀'.repeat(2000) } })).status, 201);
  for (const path of ['/admin/reviews?status=other', '/admin/reviews?scene=', '/admin/reviews?limit=101',
    '/admin/reports?status=other', '/admin/reports?offset=-1', '/admin/scenes?limit=0',
    '/admin/reports?status=open&status=resolved']) {
    const response = await f.request(path, { admin: true });
    assert.equal(response.status, 400, path);
    assert.equal(response.body.error, 'invalid_request');
    assert.equal(typeof response.body.requestId, 'string');
  }
});

test('retention deletes only records strictly older than cutoff and preserves refreshed report history', async t => {
  const cutoff = Date.parse('2025-11-02T00:00:00.000Z');
  const now = cutoff + 365 * 86400000;
  const f = await fixture(t, { now: cutoff - 1 });
  async function pair() {
    return {
      reviewId: (await f.request('/image/check', { method: 'POST', body: imageBody })).body.reviewId,
      reportId: (await f.request('/reports', { method: 'POST', body: reportBody })).body.id
    };
  }
  const expired = await pair();
  const refreshed = await pair();
  await f.request(`/admin/reports/${refreshed.reportId}/handle`, { method: 'POST', admin: true,
    body: { status: 'accepted', result: 'Old handling retained with refreshed report', actorId: 'admin-1' } });
  f.setTime(cutoff);
  const boundary = await pair();
  f.setTime(now - 86400000);
  await f.request(`/admin/reviews/${refreshed.reviewId}/resolve`, { method: 'POST', admin: true, body: resolution });
  await f.request(`/admin/reports/${refreshed.reportId}/handle`, { method: 'POST', admin: true,
    body: { status: 'resolved', result: 'Handled recently', actorId: 'admin-1' } });
  f.setTime(now);
  const deleted = f.ctx.cleanup();
  assert.equal(deleted.review, 1);
  assert.equal(deleted.reports, 1);
  assert.equal(deleted.image, 2);
  assert.equal((await f.request(`/reviews/${expired.reviewId}`)).status, 404);
  assert.equal((await f.request(`/admin/reports/${expired.reportId}`, { admin: true })).status, 404);
  assert.equal((await f.request(`/reviews/${boundary.reviewId}`)).status, 200);
  assert.equal((await f.request(`/admin/reports/${boundary.reportId}`, { admin: true })).status, 200);
  assert.equal((await f.request(`/reviews/${refreshed.reviewId}`)).body.decision, 'pass');
  assert.equal((await f.request(`/admin/reports/${refreshed.reportId}`, { admin: true })).body.history.length, 2);
  f.setTime(now + 1);
  assert.equal(f.ctx.cleanup().reports, 1);
  assert.equal((await f.request(`/reviews/${boundary.reviewId}`)).status, 404);
});

test('audit failures roll back policy, image queue, report creation, resolution, and handling', async t => {
  const f = await fixture(t);
  const reviewId = (await f.request('/image/check', { method: 'POST', body: imageBody })).body.reviewId;
  const reportId = (await f.request('/reports', { method: 'POST', body: reportBody })).body.id;
  const recordAudit = f.ctx.recordAudit;
  f.ctx.recordAudit = () => { throw new Error('Simulated audit write failure'); };
  try {
    for (const [path, body, admin, method] of [
      ['/admin/scenes/post', { preReview: true }, true, 'PUT'],
      ['/image/check', imageBody, false, 'POST'],
      ['/reports', reportBody, false, 'POST'],
      [`/admin/reviews/${reviewId}/resolve`, resolution, true, 'POST'],
      [`/admin/reports/${reportId}/handle`, { status: 'resolved', result: 'Removed', actorId: 'admin-1' }, true, 'POST']
    ]) assert.equal((await f.request(path, { method, body, admin })).status, 500, path);
  } finally { f.ctx.recordAudit = recordAudit; }
  assert.equal(f.ctx.review.requiresReview('alpha', 'post'), false);
  assert.equal((await f.request('/admin/reviews', { admin: true })).body.total, 1);
  assert.equal((await f.request('/admin/reports', { admin: true })).body.total, 1);
  assert.equal((await f.request(`/reviews/${reviewId}`)).body.status, 'pending');
  assert.equal((await f.request(`/admin/reports/${reportId}`, { admin: true })).body.history.length, 0);
  assert.equal(f.ctx.db.prepare('SELECT count(*) AS n FROM image_decisions').get().n, 1);
});

test('policies and queued payloads survive a service restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'moderation-ext-'));
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'moderation.sqlite');
  const app = await createApp({ apps, dbPath, seedKeywords: false, clock: () => new Date('2026-11-02T00:00:00.000Z') });
  const ctx = app.locals.context;
  ctx.db.prepare('INSERT INTO review_policies VALUES (?, ?, ?, ?)').run('alpha', 'post', 1, ctx.now());
  const id = ctx.review.enqueue({ appId: 'alpha', kind: 'text', scene: 'post', payload: { text: 'Persisted' } });
  app.locals.close();
  const reopened = await createApp({ apps, dbPath, seedKeywords: false, clock: () => new Date('2026-11-02T00:00:00.000Z') });
  try {
    assert.equal(reopened.locals.context.review.requiresReview('alpha', 'post'), true);
    const row = reopened.locals.context.db.prepare('SELECT id, payload_json FROM review_items WHERE app_id = ? AND id = ?').get('alpha', id);
    assert.equal(row.id, id);
    assert.deepEqual(JSON.parse(row.payload_json), { text: 'Persisted' });
  } finally { reopened.locals.close(); }
});

test('SDK checks and report/review methods work against the real service', async t => {
  const f = await fixture(t);
  const client = new ModerationClient({ baseUrl: f.baseUrl, appId: 'alpha', apiKey: apps[0].apiKey });
  assert.equal((await client.checkIp({ scene: 'post', ip: '192.0.2.1' })).decision, 'pass');
  assert.equal((await client.checkText({ scene: 'post', text: 'Hello' })).decision, 'pass');
  const imageResult = await client.checkImage(imageBody);
  assert.equal(imageResult.decision, 'review');
  assert.equal((await client.getReview(imageResult.reviewId)).status, 'pending');
  assert.equal((await client.submitReport(reportBody)).status, 'open');
});

test('report outcomes and ordered handling history survive a service restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'moderation-report-restart-'));
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  const dbPath = join(dir, 'moderation.sqlite');
  const first = await fixture(t, { dbPath });
  let reopened;
  t.after(async () => {
    await first.close();
    await reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = (await first.request('/reports', { method: 'POST', body: reportBody })).body.id;
  for (const status of ['accepted', 'resolved']) {
    await first.request(`/admin/reports/${id}/handle`, { method: 'POST', admin: true,
      body: { status, result: `Result ${status}`, actorId: 'admin-1' } });
  }
  await first.close();
  reopened = await fixture(t, { dbPath });
  const persisted = await reopened.request(`/admin/reports/${id}`, { admin: true });
  assert.equal(persisted.body.status, 'resolved');
  assert.equal(persisted.body.reason, reportBody.reason);
  assert.deepEqual(persisted.body.history.map(event => event.status), ['accepted', 'resolved']);
});

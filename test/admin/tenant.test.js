import test from 'node:test';
import assert from 'node:assert/strict';
import { adminFixture } from './fixture.js';

async function ready(t) {
  const f = await adminFixture(t);
  await f.setupSuper();
  const created = await f.request('/admin/api/apps', { method: 'POST', body: { appId: 'alpha', name: 'Alpha' } });
  assert.equal(created.status, 201);
  await f.request('/admin/api/apps', { method: 'POST', body: { appId: 'beta', name: 'Beta' } });
  return f;
}

test('keywords are managed per app through the console', async t => {
  const f = await ready(t);

  const created = await f.request('/admin/api/apps/alpha/keywords', {
    method: 'POST', body: { word: 'forbidden', category: 'custom' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.word, 'forbidden');
  assert.equal(created.body.category, 'custom');
  assert.equal(created.body.enabled, true);

  const duplicate = await f.request('/admin/api/apps/alpha/keywords', {
    method: 'POST', body: { word: 'forbidden', category: 'custom' }
  });
  assert.equal(duplicate.status, 409);

  // beta never sees alpha's keyword.
  assert.equal((await f.request('/admin/api/apps/beta/keywords')).body.total, 0);
  assert.equal((await f.request('/admin/api/apps/beta/keywords', {
    method: 'POST', body: { word: 'privateword', category: 'custom' }
  })).status, 201);
  assert.equal((await f.request(`/admin/api/apps/beta/keywords/${created.body.id}`, {
    method: 'PATCH', body: { enabled: false }
  })).status, 404);

  const patched = await f.request(`/admin/api/apps/alpha/keywords/${created.body.id}`, {
    method: 'PATCH', body: { enabled: false }
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.enabled, false);

  assert.equal((await f.request(`/admin/api/apps/alpha/keywords/${created.body.id}`, { method: 'DELETE' }))
    .body.deleted, true);
  assert.equal((await f.request('/admin/api/apps/alpha/keywords')).body.total, 0);
});

test('keyword import is all-or-nothing and reports counts', async t => {
  const f = await ready(t);

  const merged = await f.request('/admin/api/apps/alpha/keywords/import', {
    method: 'POST',
    body: {
      mode: 'merge',
      items: [
        { word: 'alpha word', category: 'custom' },
        { word: 'beta word', category: 'custom', enabled: false }
      ]
    }
  });
  assert.equal(merged.status, 200);
  assert.deepEqual(merged.body, { created: 2, updated: 0, skipped: 0, total: 2 });

  // Re-importing the same rows is idempotent.
  const again = await f.request('/admin/api/apps/alpha/keywords/import', {
    method: 'POST',
    body: { items: [{ word: 'alpha word', category: 'custom' }] }
  });
  assert.deepEqual(again.body, { created: 0, updated: 0, skipped: 1, total: 1 });

  // A single invalid row rejects the entire batch.
  const before = (await f.request('/admin/api/apps/alpha/keywords')).body.total;
  const rejected = await f.request('/admin/api/apps/alpha/keywords/import', {
    method: 'POST',
    body: { items: [{ word: 'fine word', category: 'custom' }, { word: 'bad', category: 'not-a-category' }] }
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, 'invalid_request');
  assert.equal((await f.request('/admin/api/apps/alpha/keywords')).body.total, before);

  // replace clears the touched categories first.
  const replaced = await f.request('/admin/api/apps/alpha/keywords/import', {
    method: 'POST',
    body: { mode: 'replace', items: [{ word: 'only word', category: 'custom' }] }
  });
  assert.deepEqual(replaced.body, { created: 1, updated: 0, skipped: 0, total: 1 });
  const listed = await f.request('/admin/api/apps/alpha/keywords');
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.items[0].word, 'only word');

  const audit = await f.request('/admin/api/apps/alpha/audit?action=keyword.import');
  assert.equal(audit.body.total, 3);
});

test('keyword import rejects oversized and malformed batches', async t => {
  const f = await ready(t);
  const tooMany = Array.from({ length: 5_001 }, (_, index) => ({ word: `word ${index}`, category: 'custom' }));
  const response = await f.request('/admin/api/apps/alpha/keywords/import', {
    method: 'POST', body: { items: tooMany }
  });
  assert.equal(response.status, 400);
  assert.equal((await f.request('/admin/api/apps/alpha/keywords/import', {
    method: 'POST', body: { items: 'nope' }
  })).status, 400);
  assert.equal((await f.request('/admin/api/apps/alpha/keywords/import', {
    method: 'POST', body: { items: [{ word: 'x', category: 'custom' }], mode: 'merge-ish' }
  })).status, 400);
});

test('keyword export returns the app dictionary only', async t => {
  const f = await ready(t);
  await f.request('/admin/api/apps/alpha/keywords/import', {
    method: 'POST', body: { items: [{ word: 'alpha one', category: 'custom' }, { word: 'alpha two', category: 'politics' }] }
  });
  await f.request('/admin/api/apps/beta/keywords', { method: 'POST', body: { word: 'beta one', category: 'custom' } });

  const exported = await f.request('/admin/api/apps/alpha/keywords/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.body.items.length, 2);
  for (const item of exported.body.items) {
    assert.deepEqual(Object.keys(item).sort(), ['category', 'enabled', 'word']);
  }
  assert.equal(exported.body.items.some(item => item.word === 'beta one'), false);
});

test('IP rules and scene policies are reachable per app', async t => {
  const f = await ready(t);

  const rule = await f.request('/admin/api/apps/alpha/ip-rules', {
    method: 'POST', body: { type: 'cidr', value: '192.0.2.0/24', reason: 'abuse' }
  });
  assert.equal(rule.status, 201);
  assert.equal(rule.body.type, 'cidr');
  const rules = await f.request('/admin/api/apps/alpha/ip-rules');
  assert.equal(rules.body.total, 1);
  assert.equal((await f.request('/admin/api/apps/beta/ip-rules')).body.total, 0);
  assert.equal((await f.request(`/admin/api/apps/alpha/ip-rules/${rule.body.id}`, { method: 'DELETE' })).status, 200);

  const scenes = await f.request('/admin/api/apps/alpha/scenes');
  assert.equal(scenes.status, 200);
  assert.equal(scenes.body.total, 0);
  const policy = await f.request('/admin/api/apps/alpha/scenes/post', {
    method: 'PUT', body: { preReview: true }
  });
  assert.equal(policy.status, 200);
  assert.equal(policy.body.preReview, true);
  assert.equal((await f.request('/admin/api/apps/alpha/scenes/post')).body.preReview, true);
  assert.equal((await f.request('/admin/api/apps/beta/scenes/post')).body.preReview, false);
});

test('review queue and reports stay app scoped', async t => {
  const f = await ready(t);

  // Queue an item directly through the module context, then resolve it via HTTP.
  const reviewId = f.ctx.review.enqueue({
    appId: 'alpha', kind: 'text', scene: 'post', payload: { text: 'queued text' }, userId: '42'
  });
  const listed = await f.request('/admin/api/apps/alpha/reviews?status=pending');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.items[0].id, reviewId);
  assert.equal((await f.request('/admin/api/apps/beta/reviews')).body.total, 0);
  assert.equal((await f.request(`/admin/api/apps/beta/reviews/${reviewId}`)).status, 404);

  const resolved = await f.request(`/admin/api/apps/alpha/reviews/${reviewId}/resolve`, {
    method: 'POST', body: { decision: 'block', reason: 'manual', actorId: 'admin-1' }
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.decision, 'block');

  // Reports are submitted by end users through `/v1`; the console lists and handles them.
  f.ctx.db.prepare(`INSERT INTO reports (id, app_id, target_type, target_id, reporter_id, reason, created_at, updated_at)
    VALUES ('report-1', 'alpha', 'post', '1', 'u1', 'spam', ?, ?)`).run(f.ctx.now(), f.ctx.now());
  const reports = await f.request('/admin/api/apps/alpha/reports?status=open');
  assert.equal(reports.body.total, 1);
  assert.equal((await f.request('/admin/api/apps/beta/reports')).body.total, 0);
  const handled = await f.request('/admin/api/apps/alpha/reports/report-1/handle', {
    method: 'POST', body: { status: 'resolved', result: 'removed', actorId: 'admin-1' }
  });
  assert.equal(handled.status, 200);
  assert.equal(handled.body.status, 'resolved');
});

test('console audit reads are scoped to the app', async t => {
  const f = await ready(t);
  await f.request('/admin/api/apps/alpha/keywords', { method: 'POST', body: { word: 'audited', category: 'custom' } });

  const alpha = await f.request('/admin/api/apps/alpha/audit');
  assert.equal(alpha.status, 200);
  assert.equal(alpha.body.items.some(row => row.action === 'keyword.create'), true);
  const beta = await f.request('/admin/api/apps/beta/audit');
  assert.equal(beta.body.items.some(row => row.action === 'keyword.create'), false);
  assert.equal(alpha.body.items.every(row => row.appId === 'alpha'), true);
});

test('tenant routes require a session and reject write roles correctly', async t => {
  const f = await ready(t);
  const viewer = await f.asViewer(f, { username: 'tenant.viewer', password: 'a tenant viewer pass' });
  assert.equal(viewer.status, 200);

  f.cookie = null;
  f.csrf = null;
  assert.equal((await f.request('/admin/api/apps/alpha/keywords')).status, 401);

  f.cookie = viewer.cookie;
  f.csrf = viewer.csrf;
  assert.equal((await f.request('/admin/api/apps/alpha/keywords')).status, 200);
  assert.equal((await f.request('/admin/api/apps/alpha/keywords', {
    method: 'POST', body: { word: 'viewer word', category: 'custom' }
  })).status, 403);
});

test('console routes reject non-JSON write bodies', async t => {
  const f = await ready(t);
  const response = await fetch(`${f.baseUrl}/admin/api/apps/alpha/keywords`, {
    method: 'POST',
    headers: { cookie: f.cookie, 'x-csrf-token': f.csrf, 'content-type': 'text/plain' },
    body: 'word=hello'
  });
  // Core's JSON guard answers 415; a missing content type is a 415 as well.
  assert.equal([415, 400].includes(response.status), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { adminFixture } from './fixture.js';

async function createApp(f, appId, name) {
  return f.request('/admin/api/apps', { method: 'POST', body: { appId, name } });
}

test('app lifecycle: create, list, read, update, delete', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();

  const created = await createApp(f, 'qflistudio', 'QFLI Studio');
  assert.equal(created.status, 201);
  assert.equal(created.body.app.appId, 'qflistudio');
  assert.equal(created.body.app.name, 'QFLI Studio');
  assert.equal(created.body.app.status, 'active');
  assert.equal(typeof created.body.keys.apiKey, 'string');
  assert.equal(typeof created.body.keys.adminKey, 'string');
  assert.ok(created.body.keys.apiKey.length >= 32);
  assert.notEqual(created.body.keys.apiKey, created.body.keys.adminKey);

  const duplicate = await createApp(f, 'qflistudio');
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, 'conflict');

  const invalid = await createApp(f, '../etc');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'invalid_request');

  // The system tenant is never addressable.
  assert.equal((await createApp(f, '_system')).status, 400);

  const list = await f.request('/admin/api/apps');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.limit, 50);
  assert.equal(list.body.offset, 0);
  assert.deepEqual(list.body.items[0].keySummary, { api: 'active', admin: 'active' });
  assert.equal(list.body.items.some(item => item.appId === '_system'), false);

  const read = await f.request('/admin/api/apps/qflistudio');
  assert.equal(read.status, 200);
  assert.equal(read.body.name, 'QFLI Studio');
  assert.equal(read.body.keys, undefined);

  const updated = await f.request('/admin/api/apps/qflistudio', {
    method: 'PATCH', body: { name: 'QFLI Studio 2', status: 'disabled' }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'QFLI Studio 2');
  assert.equal(updated.body.status, 'disabled');

  const filtered = await f.request('/admin/api/apps?status=active');
  assert.equal(filtered.body.total, 0);
  assert.equal((await f.request('/admin/api/apps?status=bogus')).status, 400);

  const removed = await f.request('/admin/api/apps/qflistudio', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { deleted: true });
  assert.equal((await f.request('/admin/api/apps/qflistudio')).status, 404);
  assert.equal((await f.request('/admin/api/apps/qflistudio', { method: 'DELETE' })).status, 404);
});

test('keys are hashed at rest and disclosed only once', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const created = await createApp(f, 'alpha');
  const { apiKey, adminKey } = created.body.keys;

  const rows = f.db.prepare('SELECT token_hash, status, kind FROM app_keys WHERE app_id = ?').all('alpha');
  assert.equal(rows.length, 2);
  assert.equal(rows.some(row => row.token_hash === apiKey || row.token_hash === adminKey), false);
  for (const row of rows) assert.match(row.token_hash, /^[0-9a-f]{64}$/);

  // The resolved role is what core's /v1 authentication consumes.
  assert.equal(f.ctx.appStore.resolveToken('alpha', apiKey), 'api');
  assert.equal(f.ctx.appStore.resolveToken('alpha', adminKey), 'admin');
  assert.equal(f.ctx.appStore.resolveToken('alpha', 'nope'), null);

  const keys = await f.request('/admin/api/apps/alpha/keys');
  assert.equal(keys.status, 200);
  assert.equal(keys.body.items.length, 2);
  for (const item of keys.body.items) {
    assert.equal(item.status, 'active');
    assert.equal(Object.hasOwn(item, 'apiKey'), false);
    assert.equal(Object.hasOwn(item, 'secret'), false);
    assert.ok(item.keyId);
  }
});

test('rotation keeps the previous key usable until the grace window ends', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const first = (await createApp(f, 'alpha')).body.keys;

  const rotated = await f.request('/admin/api/apps/alpha/keys/rotate', { method: 'POST', body: { graceMs: 60_000 } });
  assert.equal(rotated.status, 200);
  const second = rotated.body;
  assert.notEqual(second.apiKey, first.apiKey);
  assert.ok(second.graceUntil);

  // Both generations resolve inside the grace window.
  assert.equal(f.ctx.appStore.resolveToken('alpha', first.apiKey), 'api');
  assert.equal(f.ctx.appStore.resolveToken('alpha', second.apiKey), 'api');

  const listed = await f.request('/admin/api/apps/alpha/keys');
  const statuses = listed.body.items.map(item => `${item.kind}:${item.status}`).sort();
  assert.deepEqual(statuses, ['admin:active', 'admin:grace', 'api:active', 'api:grace']);

  // After the window the old key stops resolving and is reported revoked.
  f.advance(61_000);
  assert.equal(f.ctx.appStore.resolveToken('alpha', first.apiKey), null);
  assert.equal(f.ctx.appStore.resolveToken('alpha', second.apiKey), 'api');
  const after = await f.request('/admin/api/apps/alpha/keys');
  assert.equal(after.body.items.filter(item => item.status === 'grace').length, 0);
});

test('revocation takes effect immediately for active and grace keys', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const first = (await createApp(f, 'alpha')).body.keys;
  await f.request('/admin/api/apps/alpha/keys/rotate', { method: 'POST', body: { graceMs: 60_000 } });

  const revoked = await f.request('/admin/api/apps/alpha/keys/revoke', { method: 'POST', body: { reason: 'leaked' } });
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body, { revoked: true });

  assert.equal(f.ctx.appStore.resolveToken('alpha', first.apiKey), null);
  const listed = await f.request('/admin/api/apps/alpha/keys');
  assert.equal(listed.body.items.every(item => item.status === 'revoked'), true);
  assert.equal(f.db.prepare("SELECT revoked_reason FROM app_keys WHERE app_id='alpha' LIMIT 1").get().revoked_reason, 'leaked');
});

test('a disabled app rejects its keys immediately', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const keys = (await createApp(f, 'alpha')).body.keys;
  assert.equal(f.ctx.appStore.resolveToken('alpha', keys.apiKey), 'api');

  await f.request('/admin/api/apps/alpha', { method: 'PATCH', body: { status: 'disabled' } });
  assert.equal(f.ctx.appStore.resolveToken('alpha', keys.apiKey), null);
  assert.equal(f.ctx.appStore.resolveToken('alpha', keys.adminKey), null);
});

test('graceMs is validated on issue and rotate', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  await createApp(f, 'alpha');
  for (const graceMs of [999, 604_800_001, 'soon', 1.5]) {
    const response = await f.request('/admin/api/apps/alpha/keys/rotate', { method: 'POST', body: { graceMs } });
    assert.equal(response.status, 400, String(graceMs));
    assert.equal(response.body.error, 'invalid_request');
  }
});

test('role matrix: viewer reads, admin manages apps, only super deletes', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  await createApp(f, 'alpha');
  const adminSession = await f.asAdmin(f, { username: 'app.admin', password: 'app admin password value', role: 'admin' });
  const viewerSession = await f.asViewer(f, { username: 'read.only', password: 'read only password value', role: 'viewer' });

  // viewer
  f.cookie = viewerSession.cookie;
  f.csrf = viewerSession.csrf;
  assert.equal((await f.request('/admin/api/apps')).status, 200);
  assert.equal((await f.request('/admin/api/apps', { method: 'POST', body: { appId: 'beta' } })).status, 403);
  assert.equal((await f.request('/admin/api/apps/alpha', { method: 'PATCH', body: { name: 'x' } })).status, 403);
  assert.equal((await f.request('/admin/api/admins')).status, 403);
  assert.equal((await f.request('/admin/api/settings/oidc')).status, 403);

  // admin
  f.cookie = adminSession.cookie;
  f.csrf = adminSession.csrf;
  assert.equal((await f.request('/admin/api/apps', { method: 'POST', body: { appId: 'beta' } })).status, 201);
  assert.equal((await f.request('/admin/api/apps/beta', { method: 'PATCH', body: { name: 'Beta' } })).status, 200);
  assert.equal((await f.request('/admin/api/apps/beta/keys/rotate', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request('/admin/api/apps/beta', { method: 'DELETE' })).status, 403);
  assert.equal((await f.request('/admin/api/admins')).status, 403);
});

test('every app mutation is audited under the system tenant', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  await createApp(f, 'alpha');
  await f.request('/admin/api/apps/alpha/keys/rotate', { method: 'POST', body: {} });
  await f.request('/admin/api/apps/alpha/keys/revoke', { method: 'POST', body: {} });
  await f.request('/admin/api/apps/alpha', { method: 'PATCH', body: { name: 'Alpha' } });
  await f.request('/admin/api/apps/alpha', { method: 'DELETE' });

  const actions = f.db.prepare('SELECT action, app_id, actor_id FROM audit_events ORDER BY created_at, rowid').all()
    .filter(row => row.action.startsWith('admin.app') || row.action.startsWith('admin.key'));
  const names = actions.map(row => row.action);
  for (const expected of ['admin.app.create', 'admin.key.rotate', 'admin.key.revoke', 'admin.app.update', 'admin.app.delete']) {
    assert.ok(names.includes(expected), expected);
  }
  for (const row of actions) {
    assert.equal(row.app_id, '_system');
    assert.match(row.actor_id, /^admin:[0-9a-f-]{36}$/);
  }
});

test('unknown apps and unknown fields are handled safely', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  assert.equal((await f.request('/admin/api/apps/missing/keys')).status, 404);
  assert.equal((await f.request('/admin/api/apps/missing/keys/rotate', { method: 'POST', body: {} })).status, 404);
  assert.equal((await f.request('/admin/api/apps/missing/keys/revoke', { method: 'POST', body: {} })).status, 404);
  assert.equal((await f.request('/admin/api/apps/missing', { method: 'PATCH', body: { name: 'x' } })).status, 404);

  await createApp(f, 'alpha');
  const badName = await f.request('/admin/api/apps/alpha', { method: 'PATCH', body: { name: '' } });
  assert.equal(badName.status, 400);
  const badStatus = await f.request('/admin/api/apps/alpha', { method: 'PATCH', body: { status: 'gone' } });
  assert.equal(badStatus.status, 400);
});

test('unauthenticated callers cannot reach app administration', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  f.cookie = null;
  f.csrf = null;
  for (const [path, method] of [['/admin/api/apps', 'GET'], ['/admin/api/apps', 'POST'],
    ['/admin/api/apps/alpha/keys', 'GET'], ['/admin/api/meta', 'GET'], ['/admin/api/admins', 'GET']]) {
    const response = await f.request(path, { method, body: method === 'GET' ? undefined : { appId: 'x' } });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

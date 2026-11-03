import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../../src/app.js';

// Exercises the full operator journey described in
// docs/proposals/dynamic-config-contract.md: bootstrap with the one-time code,
// sign in, create an application, mint keys, and drive every tenant resource
// the admin console talks to. It also proves the mounted console is consistent
// with the service modules that back the tenant routes.

const quiet = { info() {}, warn() {}, error() {} };

async function console(t, options = {}) {
  let setup;
  const app = await createApp({ dbPath: ':memory:', seedKeywords: false, log: quiet,
    onSetupCode: value => (setup = value, value), ...options });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrf = '';
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    server.closeIdleConnections();
    app.locals.close();
  });
  async function call(method, path, body, { anonymous = false } = {}) {
    const response = await fetch(base + path, { method, headers: {
      'Content-Type': 'application/json',
      ...(anonymous || !cookie ? {} : { Cookie: cookie }),
      ...(anonymous || !csrf ? {} : { 'X-CSRF-Token': csrf })
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const entry of response.headers.getSetCookie?.() ?? []) cookie = entry.split(';')[0];
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed.csrfToken === 'string') csrf = parsed.csrfToken;
    return { status: response.status, body: parsed, headers: response.headers };
  }
  return { app, call, base, get setup() { return setup; }, ctx: app.locals.context,
    get cookie() { return cookie; }, get csrf() { return csrf; } };
}

test('the console serves its shell and rejects unknown asset paths', async t => {
  const c = await console(t);
  const shell = await fetch(`${c.base}/admin/`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<html/u);
  assert.match(shell.headers.get('content-security-policy') ?? '', /default-src 'self'/u);
  assert.equal((await fetch(`${c.base}/admin/../src/app.js`)).status, 404);
  // The deployment docs point operators at these deep links.
  for (const [path, target] of [['/admin/setup', '/admin/#/init'], ['/admin/login', '/admin/#/login']]) {
    const redirect = await fetch(`${c.base}${path}`, { redirect: 'manual' });
    assert.equal(redirect.status, 302, path);
    assert.equal(redirect.headers.get('location'), target, path);
  }
  assert.equal((await fetch(`${c.base}/admin/index.html`)).status, 200);
});

test('setup is one-time, then the operator can sign in and manage applications', async t => {
  const c = await console(t);
  assert.equal(c.setup.required, true);
  const status = await c.call('GET', '/admin/api/setup', undefined, { anonymous: true });
  assert.deepEqual(status.body.required, true);
  assert.equal(status.body.available, true);

  const created = await c.call('POST', '/admin/api/setup', { code: c.setup.code, username: 'root',
    password: 'super-secret-password' }, { anonymous: true });
  assert.equal(created.status, 201);
  assert.equal(created.body.admin.role, 'super');

  // The code is burned and the initialisation page closes.
  assert.equal((await c.call('GET', '/admin/api/setup', undefined, { anonymous: true })).body.required, false);
  assert.equal((await c.call('POST', '/admin/api/setup', { code: c.setup.code, username: 'root2',
    password: 'another-password-1' }, { anonymous: true })).status, 409);

  const session = await c.call('GET', '/admin/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.admin.username, 'root');
  assert.ok(session.body.csrfToken);

  const app = await c.call('POST', '/admin/api/apps', { appId: 'qfli', name: 'QFLI' });
  assert.equal(app.status, 201);
  assert.ok(app.body.keys.apiKey.length >= 32);
  const keys = await c.call('GET', '/admin/api/apps/qfli/keys');
  assert.equal(keys.body.items.length, 2);
  assert.equal((await c.call('GET', '/admin/api/apps')).body.total, 1);
  return { c, appId: 'qfli', apiKey: app.body.keys.apiKey, adminKey: app.body.keys.adminKey };
});

test('every tenant resource the console uses is reachable and scoped by appId', async t => {
  const { c } = await setupSuperAdmin(t);
  await c.call('POST', '/admin/api/apps', { appId: 'alpha', name: 'Alpha' });
  await c.call('POST', '/admin/api/apps', { appId: 'beta', name: 'Beta' });

  const keyword = await c.call('POST', '/admin/api/apps/alpha/keywords', { word: '测试词', category: 'custom' });
  assert.equal(keyword.status, 201);
  assert.equal((await c.call('GET', '/admin/api/apps/alpha/keywords')).body.total, 1);
  assert.equal((await c.call('GET', '/admin/api/apps/beta/keywords')).body.total, 0,
    'another application never sees the word');
  assert.deepEqual((await c.call('GET', '/admin/api/apps/alpha/keywords/export')).body.items,
    [{ word: '测试词', category: 'custom', enabled: true }]);
  const imported = await c.call('POST', '/admin/api/apps/alpha/keywords/import', { mode: 'merge',
    items: [{ word: '批量一', category: 'custom' }, { word: '批量二', category: 'custom' }] });
  assert.deepEqual(imported.body, { created: 2, updated: 0, skipped: 0, total: 2 });
  assert.equal((await c.call('PATCH', `/admin/api/apps/alpha/keywords/${keyword.body.id}`,
    { enabled: false })).body.enabled, false);
  assert.deepEqual((await c.call('DELETE', `/admin/api/apps/alpha/keywords/${keyword.body.id}`)).body,
    { deleted: true });

  assert.equal((await c.call('POST', '/admin/api/apps/alpha/ip-rules',
    { type: 'ip', value: '192.0.2.1', reason: 'bot' })).status, 201);
  assert.equal((await c.call('GET', '/admin/api/apps/alpha/ip-rules')).body.total, 1);
  assert.equal((await c.call('GET', '/admin/api/apps/beta/ip-rules')).body.total, 0);

  assert.deepEqual((await c.call('GET', '/admin/api/apps/alpha/scenes')).body.items, []);
  const scene = await c.call('PUT', '/admin/api/apps/alpha/scenes/post', { preReview: true });
  assert.equal(scene.body.preReview, true);
  assert.equal((await c.call('GET', '/admin/api/apps/alpha/scenes/post')).body.preReview, true);

  // The review queue and reports routes come from the service modules; a 200 proves the
  // console passes them to the tenant router.
  assert.equal((await c.call('GET', '/admin/api/apps/alpha/reviews')).status, 200);
  assert.equal((await c.call('GET', '/admin/api/apps/alpha/reports')).status, 200);
  assert.equal((await c.call('GET', '/admin/api/apps/alpha/audit')).status, 200);
  assert.equal((await c.call('GET', '/admin/api/apps/beta/audit')).body.total, 0);
  assert.equal((await c.call('GET', '/admin/api/apps/alpha/meta')).status, 404);
  assert.equal((await c.call('GET', '/admin/api/meta')).status, 200);

  // Unknown, reserved, and malformed tenants are rejected rather than served empty.
  for (const path of ['/admin/api/apps/ghost', '/admin/api/apps/ghost/keywords',
    '/admin/api/apps/ghost/keys', '/admin/api/apps/ghost/scenes', '/admin/api/apps/ghost/reviews',
    '/admin/api/apps/ghost/reports', '/admin/api/apps/ghost/audit',
    '/admin/api/apps/_system/keywords', '/admin/api/apps/with%20space/keywords']) {
    assert.equal((await c.call('GET', path)).status, 404, path);
  }
  assert.equal((await c.call('POST', '/admin/api/apps/ghost/keywords',
    { word: 'x', category: 'custom' })).status, 404);
});

test('admin keys minted in the console drive the unchanged /v1 API', async t => {
  const { c } = await setupSuperAdmin(t);
  const created = await c.call('POST', '/admin/api/apps', { appId: 'qfli', name: 'QFLI' });
  const { apiKey, adminKey } = created.body.keys;
  const check = async (key, text, appId = 'qfli') => {
    const response = await fetch(`${c.base}/v1/text/check`, { method: 'POST', headers: {
      'X-App-Id': appId, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: 'post', text }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await check(apiKey, 'hello')).body.decision, 'pass');
  assert.equal((await check('x'.repeat(43), 'hello')).status, 401);

  await c.call('POST', '/admin/api/apps/qfli/keywords', { word: '违禁词', category: 'custom' });
  assert.equal((await check(apiKey, '包含违禁词的内容')).body.decision, 'block');

  // App admins keep their role for /v1/admin/*, and API keys remain forbidden there.
  const v1Admin = await fetch(`${c.base}/v1/admin/keywords`, { headers: {
    'X-App-Id': 'qfli', Authorization: `Bearer ${adminKey}` } });
  assert.equal(v1Admin.status, 200);
  const v1Api = await fetch(`${c.base}/v1/admin/keywords`, { headers: {
    'X-App-Id': 'qfli', Authorization: `Bearer ${apiKey}` } });
  assert.equal(v1Api.status, 403);

  // Rotation keeps the previous keys alive during the grace window.
  const rotated = await c.call('POST', '/admin/api/apps/qfli/keys/rotate', { graceMs: 60000 });
  assert.equal(rotated.status, 200);
  assert.equal((await check(apiKey, 'hello')).status, 200, 'the old key still works in the window');
  assert.equal((await check(rotated.body.apiKey, 'hello')).status, 200);
  assert.equal((await check(rotated.body.apiKey, 'hello', 'other')).status, 401);

  // A disabled application is rejected immediately.
  assert.equal((await c.call('PATCH', '/admin/api/apps/qfli', { status: 'disabled' })).body.status, 'disabled');
  assert.equal((await check(rotated.body.apiKey, 'hello')).status, 401);
  assert.equal((await check(apiKey, 'hello')).status, 401);
});

test('roles and CSRF are enforced across the console', async t => {
  const { c } = await setupSuperAdmin(t);
  const apiKeyOnWrite = await fetch(`${c.base}/admin/api/apps`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Cookie: c.cookie, 'X-CSRF-Token': 'wrong' },
  body: JSON.stringify({ appId: 'nope' }) });
  assert.equal(apiKeyOnWrite.status, 403);

  // A viewer may read but never write.
  const viewer = await c.call('POST', '/admin/api/admins', { username: 'watcher',
    password: 'viewer-password-1', role: 'viewer' });
  assert.equal(viewer.status, 201);
  const viewerSession = await signIn(c.base, 'watcher', 'viewer-password-1');
  const read = await fetch(`${c.base}/admin/api/apps`, { headers: { Cookie: viewerSession.cookie } });
  assert.equal(read.status, 200);
  const write = await fetch(`${c.base}/admin/api/apps`, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Cookie: viewerSession.cookie, 'X-CSRF-Token': viewerSession.csrf }, body: JSON.stringify({ appId: 'blocked' }) });
  assert.equal(write.status, 403);
  const admins = await fetch(`${c.base}/admin/api/admins`, { headers: { Cookie: viewerSession.cookie } });
  assert.equal(admins.status, 403, 'only super administrators manage accounts');
});

test('an unauthenticated visitor only reaches the public endpoints', async t => {
  const c = await console(t);
  for (const path of ['/admin/api/apps', '/admin/api/session', '/admin/api/admins', '/admin/api/meta']) {
    assert.equal((await c.call('GET', path, undefined, { anonymous: true })).status, 401, path);
  }
  const config = await c.call('GET', '/admin/api/auth/config', undefined, { anonymous: true });
  assert.equal(config.body.oidc.enabled, false, 'OIDC is hidden until configured');
  assert.equal(config.body.oidc.loginUrl, null);
  const start = await fetch(`${c.base}/admin/api/auth/oidc/start`, { redirect: 'manual' });
  assert.equal(start.status, 404, 'no login entry point while OIDC is unconfigured');
});

// --- helpers ---------------------------------------------------------------

async function setupSuperAdmin(t) {
  const c = await console(t);
  const created = await c.call('POST', '/admin/api/setup', { code: c.setup.code, username: 'root',
    password: 'super-secret-password' }, { anonymous: true });
  assert.equal(created.status, 201);
  return { c, csrf: c.csrf };
}

async function signIn(base, username, password) {
  const response = await fetch(`${base}/admin/api/session`, { method: 'POST', headers: {
    'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const body = await response.json();
  const cookie = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ');
  return { status: response.status, body, cookie, csrf: body.csrfToken };
}

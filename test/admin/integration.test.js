import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../../src/app.js';

/**
 * End-to-end wiring: the real `createApp` mounts this module under
 * `/admin/api` and core's `/v1` router behind database-backed credentials, so
 * these assertions cover the integration the unit fixtures cannot.
 */
async function startCore(t, options = {}) {
  const codes = [];
  const app = await createApp({
    dbPath: ':memory:',
    seedKeywords: false,
    onSetupCode: setup => {
      codes.push(setup);
      return setup;
    },
    log: { info() {}, warn() {}, error() {} },
    ...options
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    app.locals.close();
  });

  let cookie = null;
  let csrf = null;

  async function request(path, { method = 'GET', body, headers = {}, csrfToken = csrf, setCookies = true } = {}) {
    const sent = { ...headers };
    if (setCookies && cookie) sent.cookie = cookie;
    if (csrfToken) sent['x-csrf-token'] = csrfToken;
    if (body !== undefined) sent['content-type'] = 'application/json';
    const response = await fetch(baseUrl + path, {
      method, headers: sent, body: body === undefined ? undefined : JSON.stringify(body)
    });
    for (const entry of response.headers.getSetCookie?.() ?? []) {
      const pair = entry.split(';')[0];
      if (pair.startsWith('moderation_admin=')) cookie = pair;
    }
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  return { app, ctx: app.locals.context, baseUrl, request, codes,
    get csrf() { return csrf; }, set csrfToken(value) { csrf = value; },
    set cookie(value) { cookie = value; } };
}

test('the console boots from an empty database and creates the first super admin', async t => {
  const core = await startCore(t);
  const setup = core.codes.at(-1);
  assert.equal(setup.required, true);
  assert.equal(setup.created, true);
  assert.equal(typeof setup.code, 'string');

  const probe = await core.request('/admin/api/setup');
  assert.deepEqual(probe.body.required, true);
  assert.equal(probe.body.available, true);

  const created = await core.request('/admin/api/setup', {
    method: 'POST', csrfToken: null, headers: { origin: core.baseUrl },
    body: { code: setup.code, username: 'root.admin', password: 'correct horse battery staple' }
  });
  assert.equal(created.status, 201);
  core.csrfToken = created.body.csrfToken;

  const session = await core.request('/admin/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.admin.role, 'super');

  // Core's setup state agrees with the console's view.
  assert.deepEqual(core.ctx.config.setupState(), { required: false, available: false, expiresAt: null });
});

test('a key issued through the console authenticates against /v1 immediately', async t => {
  const core = await startCore(t);
  await core.request('/admin/api/setup', {
    method: 'POST', csrfToken: null, headers: { origin: core.baseUrl },
    body: { code: core.codes.at(-1).code, username: 'root.admin', password: 'correct horse battery staple' }
  }).then(async response => { core.csrfToken = (await core.request('/admin/api/session')).body.csrfToken;
    assert.equal(response.status, 201); });

  const app = await core.request('/admin/api/apps', { method: 'POST', body: { appId: 'qfli', name: 'QFLI' } });
  assert.equal(app.status, 201);
  const { apiKey, adminKey } = app.body.keys;

  const check = await core.request('/v1/text/check', {
    method: 'POST', setCookies: false, csrfToken: null,
    body: { scene: 'post', text: 'hello there' },
    headers: { 'X-App-Id': 'qfli', Authorization: `Bearer ${apiKey}` }
  });
  assert.equal(check.status, 200);
  assert.equal(check.body.decision, 'pass');

  // The admin key still reaches /v1/admin/*, and the API key still cannot.
  const keyword = await core.request('/v1/admin/keywords', {
    method: 'POST', setCookies: false, csrfToken: null,
    body: { word: 'forbiddenword', category: 'custom' },
    headers: { 'X-App-Id': 'qfli', Authorization: `Bearer ${adminKey}` }
  });
  assert.equal(keyword.status, 201);
  const denied = await core.request('/v1/admin/keywords', {
    method: 'POST', setCookies: false, csrfToken: null,
    body: { word: 'anotherword', category: 'custom' },
    headers: { 'X-App-Id': 'qfli', Authorization: `Bearer ${apiKey}` }
  });
  assert.equal(denied.status, 403);

  // Console-issued keywords affect /v1 checks through the shared matcher.
  const viaConsole = await core.request('/admin/api/apps/qfli/keywords', {
    method: 'POST', body: { word: 'consoleword', category: 'custom' }
  });
  assert.equal(viaConsole.status, 201);
  const blocked = await core.request('/v1/text/check', {
    method: 'POST', setCookies: false, csrfToken: null,
    body: { scene: 'post', text: 'this has consoleword inside' },
    headers: { 'X-App-Id': 'qfli', Authorization: `Bearer ${apiKey}` }
  });
  assert.equal(blocked.body.decision, 'block');
});

test('revoking through the console rejects /v1 immediately', async t => {
  const core = await startCore(t);
  await core.request('/admin/api/setup', {
    method: 'POST', csrfToken: null, headers: { origin: core.baseUrl },
    body: { code: core.codes.at(-1).code, username: 'root.admin', password: 'correct horse battery staple' }
  });
  core.csrfToken = (await core.request('/admin/api/session')).body.csrfToken;

  const app = await core.request('/admin/api/apps', { method: 'POST', body: { appId: 'qfli' } });
  const { apiKey } = app.body.keys;
  const header = { 'X-App-Id': 'qfli', Authorization: `Bearer ${apiKey}` };

  assert.equal((await core.request('/v1/text/check', {
    method: 'POST', setCookies: false, csrfToken: null, headers: header, body: { scene: 'post', text: 'ok' }
  })).status, 200);

  assert.equal((await core.request('/admin/api/apps/qfli/keys/revoke', { method: 'POST', body: {} })).status, 200);

  assert.equal((await core.request('/v1/text/check', {
    method: 'POST', setCookies: false, csrfToken: null, headers: header, body: { scene: 'post', text: 'ok' }
  })).status, 401);
});

test('disabling an app through the console rejects /v1 immediately', async t => {
  const core = await startCore(t);
  await core.request('/admin/api/setup', {
    method: 'POST', csrfToken: null, headers: { origin: core.baseUrl },
    body: { code: core.codes.at(-1).code, username: 'root.admin', password: 'correct horse battery staple' }
  });
  core.csrfToken = (await core.request('/admin/api/session')).body.csrfToken;

  const app = await core.request('/admin/api/apps', { method: 'POST', body: { appId: 'qfli' } });
  const header = { 'X-App-Id': 'qfli', Authorization: `Bearer ${app.body.keys.apiKey}` };

  await core.request('/admin/api/apps/qfli', { method: 'PATCH', body: { status: 'disabled' } });
  assert.equal((await core.request('/v1/text/check', {
    method: 'POST', setCookies: false, csrfToken: null, headers: header, body: { scene: 'post', text: 'ok' }
  })).status, 401);
});

test('console audit writes land in the system tenant without leaking to apps', async t => {
  const core = await startCore(t);
  await core.request('/admin/api/setup', {
    method: 'POST', csrfToken: null, headers: { origin: core.baseUrl },
    body: { code: core.codes.at(-1).code, username: 'root.admin', password: 'correct horse battery staple' }
  }).then(() => 0);
  core.csrfToken = (await core.request('/admin/api/session')).body.csrfToken;
  await core.request('/admin/api/apps', { method: 'POST', body: { appId: 'qfli' } });

  const rows = core.ctx.db.prepare("SELECT app_id, action FROM audit_events WHERE action LIKE 'admin.%'").all();
  assert.ok(rows.some(row => row.action === 'admin.app.create'));
  for (const row of rows) assert.equal(row.app_id, '_system');

  const system = core.ctx.db.prepare("SELECT status FROM applications WHERE app_id = '_system'").get();
  assert.equal(system.status, 'disabled');
});

test('an empty database still serves the console when no apps are configured', async t => {
  const core = await startCore(t);
  const anonymous = await core.request('/v1/text/check', {
    method: 'POST', setCookies: false, csrfToken: null,
    headers: { 'X-App-Id': 'qfli', Authorization: `Bearer ${'a'.repeat(40)}` },
    body: { scene: 'post', text: 'hello' }
  });
  assert.equal(anonymous.status, 401);
  assert.equal((await core.request('/healthz')).status, 200);
  assert.equal((await core.request('/admin/api/setup')).body.required, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../../src/app.js';

// Drives the real admin UI API client (public/admin/js/api.js) against a live
// service. The browser shims below supply only what the module touches, so a
// divergence between the bundle and the admin API fails here rather than in a
// browser. It complements the HTTP-level test in admin-console.test.js.

const quiet = { info() {}, warn() {}, error() {} };

test('the admin UI client drives the real service end to end', async t => {
  let setup;
  const app = await createApp({ dbPath: ':memory:', seedKeywords: false, log: quiet,
    onSetupCode: value => (setup = value, value) });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  const realFetch = globalThis.fetch;
  let cookieJar = '';
  globalThis.window = { location: { origin } };
  globalThis.fetch = async (url, init = {}) => {
    const headers = { ...(init.headers ?? {}) };
    if (cookieJar) headers.Cookie = cookieJar;
    const response = await realFetch(String(url), { ...init, headers });
    for (const entry of response.headers.getSetCookie?.() ?? []) cookieJar = entry.split(';')[0];
    return response;
  };
  t.after(async () => {
    delete globalThis.window;
    globalThis.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
    server.closeIdleConnections();
    app.locals.close();
  });

  // Re-imported per test so module state (csrf, current app) starts clean.
  const { api, setCurrentApp, getCurrentApp } = await import('../../public/admin/js/api.js');

  // Initialisation page.
  assert.deepEqual(await api.bootstrapStatus(), { required: true, available: true, expiresAt: setup.expiresAt });
  const started = await api.bootstrap({ code: setup.code, username: 'root', password: 'super-secret-password' });
  assert.equal(started.admin.role, 'super');
  assert.equal((await api.bootstrapStatus()).required, false, 'the setup page closes after initialisation');

  // Chrome: a normalised session plus the application list.
  const session = await api.session();
  assert.equal(session.username, 'root');
  assert.equal(session.role, 'super');
  assert.deepEqual(session.apps, []);

  // Applications page: create, list, and select.
  const created = await api.createApp({ appId: 'qfli', name: 'QFLI' });
  assert.equal(created.app.appId, 'qfli');
  assert.equal(typeof created.keys.apiKey, 'string');
  const listed = await api.listApps();
  assert.equal(listed.total, 1);
  setCurrentApp(listed.items[0].appId);
  assert.equal(getCurrentApp(), 'qfli');
  await api.updateApp('qfli', { name: 'QFLI Studio' });
  assert.equal((await api.getApp('qfli')).name, 'QFLI Studio');
  assert.equal((await api.listKeys('qfli')).items.length, 2);

  // Dictionary page.
  await api.createKeyword({ word: '违禁', category: 'custom' });
  assert.equal((await api.listKeywords({ limit: 50, offset: 0 })).total, 1);
  assert.equal((await api.exportKeywords()).items.length, 1);
  assert.deepEqual(await api.importKeywords({ mode: 'merge',
    items: [{ word: '另一个词', category: 'custom' }] }), { created: 1, updated: 0, skipped: 0, total: 1 });

  // IP rules, scene policy, review queue, reports, audit, meta.
  assert.equal((await api.createIpRule({ type: 'ip', value: '10.0.0.1', reason: 'test' })).type, 'ip');
  assert.equal((await api.listIpRules()).total, 1);
  await api.setScene('post', { preReview: true });
  assert.equal((await api.getScene('post')).preReview, true);
  assert.equal((await api.listScenes()).total, 1);
  assert.equal((await api.listReviews()).total, 0);
  assert.equal((await api.listReports()).total, 0);
  assert.ok((await api.listAudit()).total > 0);
  assert.equal((await api.listAdmins()).total, 1);
  assert.equal((await api.meta()).admin.username, 'root');

  // Key rotation and revocation, then disabling the application.
  const rotated = await api.rotateKey('qfli', 'api', { graceMs: 60000 });
  assert.equal(typeof rotated.apiKey, 'string');
  assert.ok(rotated.graceUntil);
  assert.deepEqual(await api.revokeKey('qfli', 'api', null, { reason: 'test' }), { revoked: true });
  await api.setAppEnabled('qfli', false);
  assert.equal((await api.getApp('qfli')).status, 'disabled');
  await api.setAppEnabled('qfli', true);
  assert.equal((await api.getApp('qfli')).status, 'active');

  // Account management and sign-out.
  const second = await api.createAdmin({ username: 'second', password: 'second-password-1', role: 'admin' });
  assert.equal(second.role, 'admin');
  await api.resetAdminPassword(second.adminId, { newPassword: 'second-password-2' });
  assert.deepEqual(await api.deleteAdmin(second.adminId), { deleted: true });
  assert.deepEqual(await api.logout(), { ok: true });
});

test('the admin UI client refuses to build a tenant URL without a selected application', async () => {
  const realFetch = globalThis.fetch;
  globalThis.window = { location: { origin: 'http://127.0.0.1:4310' } };
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const { api, setCurrentApp } = await import('../../public/admin/js/api.js');
    setCurrentApp(null);
    // The client refuses before it builds a URL, so the failure is synchronous.
    assert.throws(() => api.listKeywords(), error => error.code === 'no_app_selected');
    assert.throws(() => api.createKeyword({ word: 'x', category: 'custom' }),
      error => error.code === 'no_app_selected');
  } finally {
    delete globalThis.window;
    globalThis.fetch = realFetch;
  }
});

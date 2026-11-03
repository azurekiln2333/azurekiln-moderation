import test from 'node:test';
import assert from 'node:assert/strict';
import { adminFixture } from './fixture.js';

test('write requests require a matching CSRF token', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();

  const missing = await f.request('/admin/api/apps', { method: 'POST', csrf: false, body: { appId: 'alpha' } });
  assert.equal(missing.status, 403);
  assert.equal(missing.body.error, 'csrf_failed');

  const wrong = await f.request('/admin/api/apps', {
    method: 'POST', body: { appId: 'alpha' }, headers: { 'x-csrf-token': 'not-the-session-token' }
  });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, 'csrf_failed');

  const good = await f.request('/admin/api/apps', { method: 'POST', body: { appId: 'alpha' } });
  assert.equal(good.status, 201);

  // Reads never require the token.
  const read = await f.request('/admin/api/apps', { csrf: false });
  assert.equal(read.status, 200);
});

test('cross-site requests are rejected even with a valid CSRF token', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();

  const crossSite = await f.request('/admin/api/apps', {
    method: 'POST', body: { appId: 'alpha' }, headers: { 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.body.error, 'csrf_failed');

  const foreignOrigin = await f.request('/admin/api/apps', {
    method: 'POST', body: { appId: 'alpha' }, headers: { origin: 'https://evil.example' }
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.body.error, 'csrf_failed');

  // A same-origin request via the public origin is accepted.
  const sameOrigin = await f.request('/admin/api/apps', {
    method: 'POST', body: { appId: 'alpha' }, headers: { origin: f.baseUrl }
  });
  assert.equal(sameOrigin.status, 201);
});

test('a request carrying a foreign Origin but no session is still denied', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const response = await f.request('/admin/api/apps', {
    method: 'POST',
    body: { appId: 'alpha' },
    headers: { origin: 'https://evil.example' },
    cookies: false
  });
  assert.equal(response.status, 401);
});

test('sessions expire on the idle window and on the absolute lifetime', async t => {
  const f = await adminFixture(t, { sessionTtlMs: 4 * 3_600_000, sessionIdleMs: 30 * 60_000 });
  await f.setupSuper();

  assert.equal((await f.request('/admin/api/session')).status, 200);

  // Advancing beyond the idle window expires the session.
  f.advance(30 * 60_000 + 1_000);
  const idle = await f.request('/admin/api/session');
  assert.equal(idle.status, 401);

  // A fresh login is valid until the absolute deadline.
  const login = await f.login();
  assert.equal(login.status, 200);
  f.advance(29 * 60_000);
  assert.equal((await f.request('/admin/api/session')).status, 200);
  f.advance(4 * 3_600_000);
  assert.equal((await f.request('/admin/api/session')).status, 401);
});

test('session rows store a hash, never the cookie value', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const token = f.cookie.split('=')[1];
  const rows = f.db.prepare('SELECT token_hash, csrf_token FROM admin_sessions').all();
  assert.ok(rows.length >= 1);
  assert.equal(rows.some(row => row.token_hash === token), false);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
});

test('changing your password revokes other sessions but keeps the current one', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const firstCsrf = f.csrf;
  const firstCookie = f.cookie;

  // A second concurrent session for the same account.
  const second = await f.login();
  assert.equal(second.status, 200);
  const secondCsrf = second.body.csrfToken;
  const secondCookie = f.cookie;

  f.cookie = firstCookie;
  f.csrf = firstCsrf;
  const changed = await f.request('/admin/api/session/password', {
    method: 'POST', body: { currentPassword: 'correct horse battery staple', newPassword: 'a totally new password' }
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, { ok: true });

  assert.equal((await f.request('/admin/api/session')).status, 200);

  f.cookie = secondCookie;
  f.csrf = secondCsrf;
  assert.equal((await f.request('/admin/api/session')).status, 401);

  // The old password no longer works, the new one does.
  f.cookie = null;
  f.csrf = null;
  assert.equal((await f.login()).status, 401);
  const relogin = await f.login({ password: 'a totally new password' });
  assert.equal(relogin.status, 200);
});

test('revoke-all ends every session including the current one', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const response = await f.request('/admin/api/session/revoke-all', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.equal((await f.request('/admin/api/session')).status, 401);
});

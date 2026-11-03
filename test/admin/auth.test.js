import test from 'node:test';
import assert from 'node:assert/strict';
import { adminFixture, SUPER } from './fixture.js';

test('setup requires the one-time code and creates a super administrator', async t => {
  const f = await adminFixture(t);

  const probe = await f.request('/admin/api/setup');
  assert.equal(probe.status, 200);
  assert.equal(probe.body.required, true);
  assert.equal(probe.body.available, false);
  assert.equal(probe.body.expiresAt, null);

  const issued = f.ctx.admin.setupCodes.issue({ code: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' });
  const pending = await f.request('/admin/api/setup');
  assert.equal(pending.body.available, true);
  assert.equal(pending.body.expiresAt, issued.expiresAt);

  const wrong = await f.request('/admin/api/setup', {
    method: 'POST', csrf: false, headers: { origin: f.baseUrl },
    body: { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ', ...SUPER }
  });
  assert.equal(wrong.status, 410);
  assert.equal(wrong.body.error, 'setup_code_invalid');

  const created = await f.setupSuper();
  assert.equal(created.status, 201);
  assert.equal(created.body.admin.username, SUPER.username);
  assert.equal(created.body.admin.role, 'super');
  assert.ok(created.body.admin.adminId);
  assert.ok(created.body.csrfToken);
  assert.equal(created.body.admin.passwordHash, undefined);

  // The setup cookie is a live session.
  f.csrf = created.body.csrfToken;
  const session = await f.request('/admin/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.admin.role, 'super');

  // Codes are one-time and the endpoint closes after initialization.
  const replay = await f.request('/admin/api/setup', {
    method: 'POST', csrf: false, headers: { origin: f.baseUrl },
    body: { code: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', ...SUPER }
  });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error, 'already_initialized');
  const after = await f.request('/admin/api/setup');
  assert.deepEqual(after.body, { required: false, available: false, expiresAt: null });
});

test('setup codes expire after 24 hours and stay hashed at rest', async t => {
  const f = await adminFixture(t);
  f.ctx.admin.setupCodes.issue({ code: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' });
  const stored = f.db.prepare('SELECT code_hash FROM setup_tokens').get();
  assert.equal(stored.code_hash.includes('AAAA'), false);
  assert.match(stored.code_hash, /^[0-9a-f]{64}$/);

  f.advance(86_400_000 + 1_000);
  const response = await f.request('/admin/api/setup', {
    method: 'POST', csrf: false, headers: { origin: f.baseUrl },
    body: { code: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', ...SUPER }
  });
  assert.equal(response.status, 410);
  assert.equal(response.body.error, 'setup_code_invalid');
  assert.equal(f.ctx.admin.accounts.count(), 0);
});

test('login, session read, and logout', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  f.cookie = null;
  f.csrf = null;

  const bad = await f.login({ password: 'wrong password value' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'invalid_credentials');
  assert.equal(f.cookie, null);

  const unknown = await f.login({ username: 'nobody.here' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, 'invalid_credentials');

  const ok = await f.login();
  assert.equal(ok.status, 200);
  assert.equal(ok.body.admin.username, SUPER.username);
  assert.equal(ok.body.admin.role, 'super');
  assert.ok(ok.body.csrfToken);
  assert.ok(ok.body.expiresAt);
  const cookie = ok.setCookie.find(entry => entry.startsWith('moderation_admin='));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//i);

  const session = await f.request('/admin/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.admin.mustChangePassword, false);

  const anonymous = await f.request('/admin/api/session', { cookies: false });
  assert.equal(anonymous.status, 401);

  const logout = await f.request('/admin/api/session', { method: 'DELETE' });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.body, { ok: true });
  const after = await f.request('/admin/api/session');
  assert.equal(after.status, 401);
  // Logout is idempotent.
  assert.equal((await f.request('/admin/api/session', { method: 'DELETE' })).status, 401);
});

test('login failures are rate limited per account and address', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  f.cookie = null;
  f.csrf = null;

  for (let index = 0; index < 5; index += 1) {
    const response = await f.login({ password: `wrong-${index}-password-value` });
    assert.equal(response.status, 401, `attempt ${index}`);
  }
  const blocked = await f.login();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 60);

  // The window slides: after 15 minutes the account is allowed again.
  f.advance(15 * 60_000 + 1_000);
  const allowed = await f.login();
  assert.equal(allowed.status, 200);
});

test('disabled accounts cannot log in', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const created = await f.request('/admin/api/admins', {
    method: 'POST', body: { username: 'viewer.one', password: 'viewer password value', role: 'viewer' }
  });
  assert.equal(created.status, 201);
  await f.request(`/admin/api/admins/${created.body.adminId}`, { method: 'PATCH', body: { status: 'disabled' } });

  f.cookie = null;
  f.csrf = null;
  const response = await f.login({ username: 'viewer.one', password: 'viewer password value' });
  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'account_disabled');
});

test('passwords are stored as scrypt digests, never plaintext', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const row = f.db.prepare('SELECT password_hash FROM admin_users WHERE username = ?').get(SUPER.username);
  assert.match(row.password_hash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(row.password_hash.includes(SUPER.password), false);
});

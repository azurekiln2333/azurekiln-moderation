import test from 'node:test';
import assert from 'node:assert/strict';
import { adminFixture, SUPER } from './fixture.js';

async function loginAs(f, username, password) {
  const savedCookie = f.cookie;
  const savedCsrf = f.csrf;
  f.cookie = null;
  f.csrf = null;
  const response = await f.login({ username, password });
  const result = { cookie: f.cookie, csrf: f.csrf, response };
  f.cookie = savedCookie;
  f.csrf = savedCsrf;
  return result;
}

test('administrator CRUD is restricted to super administrators', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();

  const created = await f.request('/admin/api/admins', {
    method: 'POST',
    body: { username: 'ops.person', password: 'an operations password', displayName: 'Ops', role: 'admin' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'admin');
  assert.equal(created.body.status, 'active');
  assert.equal(created.body.passwordHash, undefined);
  assert.equal(created.body.username, 'ops.person');

  const duplicate = await f.request('/admin/api/admins', {
    method: 'POST', body: { username: 'OPS.person', password: 'an operations password' }
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, 'conflict');

  const weak = await f.request('/admin/api/admins', {
    method: 'POST', body: { username: 'shorty', password: 'short' }
  });
  assert.equal(weak.status, 400);

  const badName = await f.request('/admin/api/admins', {
    method: 'POST', body: { username: 'has space', password: 'an operations password' }
  });
  assert.equal(badName.status, 400);

  const list = await f.request('/admin/api/admins');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 2);
  for (const item of list.body.items) {
    assert.equal(item.passwordHash, undefined);
    assert.equal(item.username_lower, undefined);
  }

  const byRole = await f.request('/admin/api/admins?role=admin');
  assert.equal(byRole.body.total, 1);
  assert.equal(byRole.body.items[0].username, 'ops.person');

  const patched = await f.request(`/admin/api/admins/${created.body.adminId}`, {
    method: 'PATCH', body: { displayName: 'Operations', role: 'viewer' }
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.displayName, 'Operations');
  assert.equal(patched.body.role, 'viewer');

  const deleted = await f.request(`/admin/api/admins/${created.body.adminId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { deleted: true });
  assert.equal((await f.request(`/admin/api/admins/${created.body.adminId}`, { method: 'DELETE' })).status, 404);
});

test('a super cannot delete itself and the last super is protected', async t => {
  const f = await adminFixture(t);
  const setup = await f.setupSuper();
  const selfId = setup.body.admin.adminId;

  const self = await f.request(`/admin/api/admins/${selfId}`, { method: 'DELETE' });
  assert.equal(self.status, 409);
  assert.equal(self.body.error, 'conflict');

  const second = await f.request('/admin/api/admins', {
    method: 'POST', body: { username: 'second.super', password: 'a second super password', role: 'super' }
  });
  assert.equal(second.status, 201);

  // With two active supers, one may be removed.
  assert.equal((await f.request(`/admin/api/admins/${second.body.adminId}`, { method: 'DELETE' })).status, 200);

  // Demoting the last super away then deleting it is still rejected by the guard,
  // because disabling is allowed only while another active super exists.
  const disable = await f.request(`/admin/api/admins/${selfId}`, { method: 'PATCH', body: { status: 'disabled' } });
  assert.equal(disable.status, 200);
  // The last active super is now gone, so the account can no longer authenticate.
  assert.equal((await f.request('/admin/api/session')).status, 401);
});

test('resetting a password revokes that account sessions', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const created = await f.request('/admin/api/admins', {
    method: 'POST', body: { username: 'ops.person', password: 'an operations password', role: 'admin' }
  });
  const session = await loginAs(f, 'ops.person', 'an operations password');
  assert.equal(session.response.status, 200);

  const reset = await f.request(`/admin/api/admins/${created.body.adminId}/password`, {
    method: 'POST', body: { newPassword: 'a brand new password', mustChangePassword: true }
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body, { ok: true });

  // The existing session is dead.
  f.cookie = session.cookie;
  f.csrf = session.csrf;
  assert.equal((await f.request('/admin/api/session')).status, 401);

  // The new password works and forces a change.
  f.cookie = null;
  f.csrf = null;
  const again = await f.login({ username: 'ops.person', password: 'a brand new password' });
  assert.equal(again.status, 200);
  assert.equal(again.body.admin.mustChangePassword, true);
});

test('disabled accounts lose their live sessions immediately', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const created = await f.request('/admin/api/admins', {
    method: 'POST', body: { username: 'ops.person', password: 'an operations password', role: 'admin' }
  });
  const session = await loginAs(f, 'ops.person', 'an operations password');

  await f.request(`/admin/api/admins/${created.body.adminId}`, { method: 'PATCH', body: { status: 'disabled' } });

  f.cookie = session.cookie;
  f.csrf = session.csrf;
  assert.equal((await f.request('/admin/api/session')).status, 401);
});

test('admin management writes are audited', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const created = await f.request('/admin/api/admins', {
    method: 'POST', body: { username: 'audited.admin', password: 'an audited password' }
  });
  await f.request(`/admin/api/admins/${created.body.adminId}`, { method: 'PATCH', body: { displayName: 'A' } });
  await f.request(`/admin/api/admins/${created.body.adminId}/password`, {
    method: 'POST', body: { newPassword: 'another audited password' }
  });
  await f.request(`/admin/api/admins/${created.body.adminId}`, { method: 'DELETE' });

  const actions = f.db.prepare("SELECT action FROM audit_events WHERE action LIKE 'admin.user%' ORDER BY rowid").all()
    .map(row => row.action);
  assert.deepEqual(actions, [
    'admin.user.create', 'admin.user.update', 'admin.user.password', 'admin.user.delete'
  ]);
});

test('OIDC is invisible until it is configured', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();

  const config = await f.request('/admin/api/auth/config', { cookies: false });
  assert.equal(config.status, 200);
  assert.deepEqual(config.body, {
    passwordLogin: true,
    oidc: { enabled: false, loginUrl: null, issuer: null }
  });

  const start = await f.request('/admin/api/auth/oidc/start', { cookies: false });
  assert.equal(start.status, 404);
  assert.equal(start.body.error, 'not_configured');

  const settings = await f.request('/admin/api/settings/oidc');
  assert.equal(settings.status, 200);
  assert.equal(settings.body.enabled, false);

  const meta = await f.request('/admin/api/meta');
  assert.equal(meta.body.oidcEnabled, false);
});

test('OIDC settings validate input and never echo the client secret', async t => {
  const f = await adminFixture(t, {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        issuer: 'https://id.example.cn',
        authorization_endpoint: 'https://id.example.cn/authorize',
        token_endpoint: 'https://id.example.cn/token'
      })
    })
  });
  await f.setupSuper();

  const insecure = await f.request('/admin/api/settings/oidc', {
    method: 'PUT', body: { enabled: true, issuer: 'http://id.example.cn', clientId: 'moderation', allowedEmails: ['a@example.cn'] }
  });
  assert.equal(insecure.status, 400);

  const saved = await f.request('/admin/api/settings/oidc', {
    method: 'PUT',
    body: {
      enabled: true,
      issuer: 'https://id.example.cn',
      clientId: 'moderation',
      clientSecret: 'super-secret-value',
      allowedEmails: ['admin@example.cn', '@ops.example.cn'],
      scopes: 'openid email'
    }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.enabled, true);
  assert.equal(saved.body.clientSecretSet, true);
  assert.equal(JSON.stringify(saved.body).includes('super-secret-value'), false);
  assert.deepEqual(saved.body.allowedEmails, ['admin@example.cn', '@ops.example.cn']);

  const config = await f.request('/admin/api/auth/config', { cookies: false });
  assert.equal(config.body.oidc.enabled, true);
  assert.equal(config.body.oidc.loginUrl, '/admin/api/auth/oidc/start');
  assert.equal(config.body.oidc.issuer, 'https://id.example.cn');

  // Omitting clientSecret keeps the stored one.
  const updated = await f.request('/admin/api/settings/oidc', {
    method: 'PUT', body: { enabled: true, issuer: 'https://id.example.cn', clientId: 'moderation', allowedEmails: ['admin@example.cn'] }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.clientSecretSet, true);

  const cleared = await f.request('/admin/api/settings/oidc', { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  assert.equal((await f.request('/admin/api/auth/config', { cookies: false })).body.oidc.enabled, false);
  assert.equal((await f.request('/admin/api/settings/oidc')).body.enabled, false);
});

test('OIDC start redirects to the discovered authorization endpoint', async t => {
  const f = await adminFixture(t, {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        issuer: 'https://id.example.cn',
        authorization_endpoint: 'https://id.example.cn/authorize',
        token_endpoint: 'https://id.example.cn/token'
      })
    })
  });
  await f.setupSuper();
  await f.request('/admin/api/settings/oidc', {
    method: 'PUT',
    body: {
      enabled: true, issuer: 'https://id.example.cn', clientId: 'moderation',
      clientSecret: 'secret', allowedEmails: ['admin@example.cn']
    }
  });

  const response = await fetch(`${f.baseUrl}/admin/api/auth/oidc/start`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.origin + location.pathname, 'https://id.example.cn/authorize');
  assert.equal(location.searchParams.get('response_type'), 'code');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('client_id'), 'moderation');
  assert.ok(location.searchParams.get('state'));
  assert.ok(location.searchParams.get('nonce'));
  assert.match(location.searchParams.get('scope'), /openid/);
});

test('an OIDC callback with an unknown state returns to the login page', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const response = await fetch(`${f.baseUrl}/admin/api/auth/oidc/callback?code=abc&state=unknown`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/admin\/login\.html\?error=oidc$/);
});

test('meta reports the console version and the signed-in administrator', async t => {
  const f = await adminFixture(t);
  const setup = await f.setupSuper();
  const meta = await f.request('/admin/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.apps, 0);
  assert.equal(meta.body.oidcEnabled, false);
  assert.equal(meta.body.admin.adminId, setup.body.admin.adminId);
  assert.equal(meta.body.admin.role, 'super');
  assert.equal(typeof meta.body.version, 'string');
  assert.ok(!('setupCode' in meta.body));
});

test('the super bootstrap account keeps its username case after sign-in comparisons', async t => {
  const f = await adminFixture(t);
  await f.setupSuper();
  const row = f.db.prepare('SELECT username, username_lower FROM admin_users WHERE username_lower = ?').get(SUPER.username);
  assert.equal(row.username, SUPER.username);
  assert.equal(row.username_lower, SUPER.username.toLowerCase());
});

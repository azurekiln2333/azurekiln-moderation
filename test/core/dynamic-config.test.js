import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createApp } from '../../src/app.js';
import { createAdminUser } from '../../src/admin-auth.js';
import { digest, fixture, checkText } from './fixture.js';
import { generateSetupCode, hashPassword, normalizeSetupCode, setupCodeHash, verifyPassword } from '../../src/crypto.js';

const quiet = { log: { info() {}, warn() {}, error() {} } };

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'moderation-config-'));
  return {
    path: join(directory, 'moderation.sqlite'),
    // Windows refuses to delete a directory while any SQLite handle is open.
    remove() { rmSync(directory, { recursive: true, force: true }); }
  };
}

async function install(t, path, overrides = {}) {
  const clock = overrides.clock ?? (() => new Date('2026-11-03T00:00:00.000Z'));
  const app = await createApp({ dbPath: path, seedKeywords: false, ...quiet, ...overrides, clock });
  t.after(() => app.locals.close());
  return app;
}

/** Closes every live instance before deleting the database, as Windows requires. */
function dispose(t, ...apps) {
  t.after(() => { for (const app of apps) app.locals.close(); });
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`,
    close: async () => { await new Promise(resolve => server.close(resolve)); server.closeIdleConnections(); } };
}

test('password hashing is salted, parameterised, and verified in constant time', () => {
  const first = hashPassword('correct horse battery staple');
  const second = hashPassword('correct horse battery staple');
  assert.match(first, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(first, second);
  assert.equal(verifyPassword('correct horse battery staple', first), true);
  assert.equal(verifyPassword('wrong password value', first), false);
  assert.equal(verifyPassword('correct horse battery staple', 'scrypt$1$1$1$a$b'), false);
  assert.equal(verifyPassword('correct horse battery staple', 'not-a-hash'), false);
  assert.throws(() => hashPassword('too short'));
});

test('setup codes are separator and case insensitive but only stored as hashes', () => {
  const code = generateSetupCode();
  assert.match(code, /^[A-Z2-9]{8}-[A-Z2-9]{8}-[A-Z2-9]{8}$/);
  assert.equal(normalizeSetupCode(code.toLowerCase()), code.replace(/-/g, ''));
  assert.equal(normalizeSetupCode('nope'), null);
  assert.equal(setupCodeHash(code), createHash('sha256').update(code.replace(/-/g, '')).digest('hex'));
});

test('application and key storage keeps only hashes and resolves both key kinds', async t => {
  const app = await install(t, ':memory:');
  const ctx = app.locals.context;
  const created = ctx.appStore.createApp({ appId: 'omega', name: 'Omega' });
  assert.equal(created.status, 'active');
  assert.equal(created.name, 'Omega');
  const keys = ctx.appStore.issueKeys('omega');
  assert.equal(keys.apiKey.length, 43);
  assert.notEqual(keys.apiKey, keys.adminKey);
  const rows = ctx.db.prepare('SELECT * FROM app_keys WHERE app_id=?').all('omega');
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map(row => row.token_hash)), new Set([digest(keys.apiKey), digest(keys.adminKey)]));
  assert.ok(rows.every(row => row.token_hash.length === 64));
  assert.equal(ctx.appStore.resolveToken('omega', keys.apiKey), 'api');
  assert.equal(ctx.appStore.resolveToken('omega', keys.adminKey), 'admin');
  assert.equal(ctx.appStore.resolveToken('omega', 'x'.repeat(43)), null);
  assert.equal(ctx.appStore.resolveToken('unknown', keys.apiKey), null);
  assert.equal(ctx.appStore.resolveToken('_system', keys.apiKey), null);
  assert.equal(ctx.appStore.keySummary('omega').api, 'active');
  assert.throws(() => ctx.appStore.createApp({ appId: 'omega' }), error => error.status === 409);
  assert.throws(() => ctx.appStore.createApp({ appId: '../bad' }), error => error.status === 400);
  assert.throws(() => ctx.appStore.createApp({ appId: '_system' }), error => error.status === 400);
});

test('rotation keeps the previous keys during the grace window and revocation is immediate', async t => {
  const temporary = temporaryDatabase();
  let now = Date.parse('2026-11-03T00:00:00.000Z');
  const app = await install(t, temporary.path, { clock: () => new Date(now) });
  const ctx = app.locals.context;
  ctx.appStore.createApp({ appId: 'alpha' });
  const first = ctx.appStore.issueKeys('alpha', { graceMs: 60_000 });
  const second = ctx.appStore.rotateKeys('alpha', { graceMs: 60_000 });
  assert.equal(ctx.appStore.resolveToken('alpha', first.apiKey), 'api', 'old key valid inside the window');
  assert.equal(ctx.appStore.resolveToken('alpha', second.apiKey), 'api', 'new key valid immediately');
  assert.deepEqual(ctx.appStore.listKeys('alpha').map(row => row.status).sort(), ['active', 'active', 'grace', 'grace']);
  now += 60_001;
  ctx.appStore.invalidateAudienceCache('alpha');
  assert.equal(ctx.appStore.resolveToken('alpha', first.apiKey), null, 'grace window closed');
  assert.equal(ctx.appStore.resolveToken('alpha', second.apiKey), 'api');
  assert.equal(ctx.appStore.expireGraceWindows() >= 2, true);
  ctx.appStore.revokeKeys('alpha', { reason: 'compromised' });
  assert.equal(ctx.appStore.resolveToken('alpha', second.apiKey), null, 'revocation applies immediately');
  assert.deepEqual([...new Set(ctx.appStore.listKeys('alpha').map(row => row.status))], ['revoked']);
  assert.throws(() => ctx.appStore.issueKeys('alpha', { graceMs: 1000 }), error => error.status === 400);
  assert.equal(ctx.appStore.issueKeys('missing'), null);
});

test('a disabled application is rejected at once while another application is unaffected', async t => {
  const app = await install(t, ':memory:');
  const ctx = app.locals.context;
  for (const appId of ['alpha', 'beta']) ctx.appStore.createApp({ appId });
  const alpha = ctx.appStore.issueKeys('alpha');
  const beta = ctx.appStore.issueKeys('beta');
  assert.equal(ctx.appStore.resolveToken('alpha', alpha.apiKey), 'api');
  ctx.appStore.updateApp('alpha', { status: 'disabled' });
  assert.equal(ctx.appStore.resolveToken('alpha', alpha.apiKey), null);
  assert.equal(ctx.appStore.resolveToken('beta', beta.apiKey), 'api');
  ctx.appStore.updateApp('alpha', { status: 'active' });
  assert.equal(ctx.appStore.resolveToken('alpha', alpha.apiKey), 'api');
  assert.throws(() => ctx.appStore.updateApp('alpha', { status: 'nope' }), error => error.status === 400);
});

test('audience caching refreshes within five seconds across processes', async t => {
  const temporary = temporaryDatabase();
  let now = Date.parse('2026-11-03T00:00:00.000Z');
  const options = { clock: () => new Date(now) };
  const first = await install(t, temporary.path, { ...options, accessClock: () => now });
  const second = await install(t, temporary.path, { ...options, accessClock: () => now });
  t.after(() => temporary.remove());
  second.locals.context.appStore.createApp({ appId: 'shared' });
  const keys = second.locals.context.appStore.issueKeys('shared');
  assert.equal(first.locals.context.appStore.resolveToken('shared', keys.apiKey), 'api');
  // A cached audience entry cannot observe the revocation by design; assert the TTL expiry instead.
  assert.equal(first.locals.context.appStore.resolveToken('shared', keys.apiKey), 'api',
    'the cached entry survives until its five second deadline');
  now += 5_000;
  assert.equal(first.locals.context.appStore.resolveToken('shared', keys.apiKey), 'api',
    'cache expiry alone does not revoke a live key');
  second.locals.context.appStore.revokeKeys('shared');
  now += 5_000;
  assert.equal(first.locals.context.appStore.resolveToken('shared', keys.apiKey), null,
    'the revocation is honoured within five seconds without a restart');
  assert.equal(second.locals.context.appStore.resolveToken('shared', keys.apiKey), null);
});

test('startup issues a one-time setup code that expires after 24 hours', async t => {
  const temporary = temporaryDatabase();
  let now = Date.parse('2026-11-03T00:00:00.000Z');
  const clock = () => new Date(now);
  const issued = [];
  const collect = { clock, onSetupCode: setup => (issued.push(setup), setup) };
  const first = await install(t, temporary.path, collect);
  assert.equal(issued.length, 1);
  assert.equal(issued[0].required, true);
  assert.equal(issued[0].created, true);
  const expiresAt = Date.parse(issued[0].expiresAt);
  assert.equal(expiresAt - now, 86_400_000, 'the code lives exactly 24 hours');
  const store = first.locals.context.db.prepare('SELECT * FROM setup_tokens').all();
  assert.equal(store.length, 1);
  assert.equal(store[0].code_hash, setupCodeHash(issued[0].code));
  assert.equal(JSON.stringify(store).includes(issued[0].code), false, 'the plaintext code is never stored');

  const second = await install(t, temporary.path, collect);
  assert.equal(issued.at(-1).created, false, 'a restart reuses the pending code');
  assert.equal(issued.at(-1).code, null);
  assert.equal(second.locals.context.config.setupState().available, true);

  now = expiresAt + 1;
  const expired = await install(t, temporary.path, collect);
  assert.equal(expired.locals.context.config.setupState().required, true,
    'a fresh code is issued once the previous one lapsed');
  assert.equal(issued.at(-1).created, true);
  assert.notEqual(issued.at(-1).code, issued[0].code);
  assert.equal(expired.locals.context.db.prepare('SELECT COUNT(*) AS n FROM setup_tokens WHERE consumed_at IS NULL').get().n, 1);
  dispose(t, first, second, expired);
  t.after(() => temporary.remove());
});

test('an existing super administrator suppresses new setup codes', async t => {
  const temporary = temporaryDatabase();
  const issued = [];
  const collect = { onSetupCode: setup => (issued.push(setup), setup) };
  const app = await install(t, temporary.path, collect);
  const ctx = app.locals.context;
  assert.equal(issued[0].required, true);
  createAdminUser(ctx, { username: 'root', password: 'root-password-2026', role: 'super' });
  ctx.transaction(() => {
    ctx.db.prepare('UPDATE setup_tokens SET consumed_at=? WHERE consumed_at IS NULL').run(ctx.now());
  });
  app.locals.close();
  const restarted = await install(t, temporary.path, collect);
  assert.deepEqual(restarted.locals.context.config.setupState(),
    { required: false, available: false, expiresAt: null });
  assert.equal(issued.at(-1).required, false);
  assert.equal(issued.at(-1).code, null);
  dispose(t, restarted);
  t.after(() => temporary.remove());
});

test('legacy MODERATION_APPS_JSON is imported once and keeps existing plaintext keys working', async t => {
  const temporary = temporaryDatabase();
  const legacy = JSON.stringify([{ appId: 'qflistudio', apiKey: 'q'.repeat(40), adminKey: 'Q'.repeat(40) }]);
  const app = await createApp({ dbPath: temporary.path, apps: legacy, seedKeywords: false, ...quiet });
  t.after(() => app.locals.close());
  const server = await listen(app);
  const call = async key => (await fetch(`${server.base}/v1/text/check`, { method: 'POST', headers: {
    'X-App-Id': 'qflistudio', Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ scene: 'post', text: 'hello' }) })).status;
  assert.equal(await call('q'.repeat(40)), 200);
  assert.equal(await call('Q'.repeat(40)), 200);
  assert.equal(await call('z'.repeat(40)), 401);
  const rows = app.locals.context.db.prepare("SELECT * FROM app_keys WHERE app_id='qflistudio'").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.token_hash.length === 64));
  await server.close();

  const restarted = await createApp({ dbPath: temporary.path, apps: legacy, seedKeywords: false, ...quiet });
  t.after(() => restarted.locals.close());
  assert.equal(restarted.locals.context.db.prepare("SELECT COUNT(*) AS n FROM app_keys WHERE app_id='qflistudio'").get().n, 2,
    'a second start must not duplicate keys');

  const broken = await createApp({ dbPath: temporary.path, apps: '{not json', seedKeywords: false, ...quiet });
  assert.equal(broken.locals.context.appStore.getApp('qflistudio').appId, 'qflistudio');
  dispose(t, restarted, broken);
  t.after(() => temporary.remove());
});

test('the service starts with no applications and no legacy configuration', async t => {
  const app = await createApp({ dbPath: ':memory:', seedKeywords: false, ...quiet });
  t.after(() => app.locals.close());
  assert.deepEqual(app.locals.context.appStore.listApps(), []);
  const server = await listen(app);
  assert.equal((await fetch(`${server.base}/healthz`)).status, 200);
  const denied = await fetch(`${server.base}/v1/text/check`, { method: 'POST', headers: { 'X-App-Id': 'alpha',
    Authorization: `Bearer ${'a'.repeat(40)}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ scene: 'post', text: 'x' }) });
  assert.equal(denied.status, 401);
  await server.close();
});

test('deleting an application removes its keys, dictionary, rules, and audit trail', async t => {
  const { request, ctx } = await fixture(t);
  await request('/v1/admin/keywords', { method: 'POST', role: 'admin', body: { word: 'gone', category: 'custom' } });
  await request('/v1/admin/ip-rules', { method: 'POST', role: 'admin', body: { type: 'ip', value: '192.0.2.7' } });
  assert.equal(ctx.appStore.deleteApp('alpha').deleted, true);
  assert.equal(ctx.appStore.getApp('alpha'), null);
  for (const table of ['app_keys', 'ip_rules', 'keywords', 'audit_events']) {
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE app_id='alpha'`).get().n, 0, table);
  }
  assert.equal((await checkText(request, 'hello')).status, 401);
  assert.equal(ctx.appStore.getApp('beta').appId, 'beta');
  assert.equal(ctx.appStore.deleteApp('missing'), null);
});

test('reset-admin script rotates the super administrator password and revokes sessions', async t => {
  const temporary = temporaryDatabase();
  const app = await createApp({ dbPath: temporary.path, seedKeywords: false, ...quiet });
  const ctx = app.locals.context;
  const admin = createAdminUser(ctx, { username: 'root', password: 'root-password-2026', role: 'super' });
  const now = ctx.now();
  ctx.db.prepare(`INSERT INTO admin_sessions (session_id, token_hash, admin_id, csrf_token, created_at,
    last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?)`)
    .run(randomUUID(), digest('token'), admin.admin_id, 'csrf', now, now, now);
  app.locals.close();
  const result = spawnSync(process.execPath, ['scripts/reset-admin.mjs', '--db', temporary.path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const password = /password: (\S+)/.exec(result.stdout)?.[1];
  assert.ok(password && password.length >= 20);
  assert.match(result.stdout, /username: root/);
  const db = new DatabaseSync(temporary.path);
  try {
    const row = db.prepare("SELECT * FROM admin_users WHERE username='root'").get();
    assert.equal(verifyPassword(password, row.password_hash), true);
    assert.equal(verifyPassword('root-password-2026', row.password_hash), false);
    assert.equal(row.must_change_password, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_sessions WHERE revoked_at IS NULL').get().n, 0);
  } finally { db.close(); }
  const missing = spawnSync(process.execPath, ['scripts/reset-admin.mjs', '--db', join(temporary.path, 'nope.sqlite')],
    { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  temporary.remove();
});

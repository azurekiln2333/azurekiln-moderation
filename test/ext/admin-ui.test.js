import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { spawnSync } from 'node:child_process';
import { createAdminUiRouter, adminUiRoot } from '../../src/admin-ui/index.js';

const root = adminUiRoot;

function readAsset(path) {
  return readFileSync(join(root, path), 'utf8');
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

async function serve(t) {
  const app = express();
  app.use('/admin', createAdminUiRouter());
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.error ?? 'internal_error' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => { server.close(done); server.closeIdleConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path, init) => {
    const response = await fetch(base + path, init);
    const body = await response.text();
    return { status: response.status, body, headers: response.headers };
  };
}

test('admin UI serves the shell at /admin/ with hardening headers and no caching', async t => {
  const request = await serve(t);
  for (const path of ['/admin', '/admin/']) {
    const response = await request(path.startsWith('/admin/') ? path : `${path}/`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/html/u);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp, 'Content-Security-Policy is required');
    assert.match(csp, /default-src 'self'/u);
    assert.match(csp, /script-src 'self'/u);
    assert.match(csp, /frame-ancestors 'none'/u);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/u);
  }
});

test('admin UI assets are served by extension and unknown paths are refused', async t => {
  const request = await serve(t);
  const css = await request('/admin/admin.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/u);
  assert.match(css.body, /\.card/u);

  const module = await request('/admin/js/main.js');
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /javascript/u);
  assert.match(module.body, /from '\.\/api\.js'/u);

  const icon = await request('/admin/favicon.svg');
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /svg/u);

  for (const path of ['/admin/missing.css', '/admin/js/missing.js', '/admin/secrets.txt',
    '/admin/js/main.js.map', '/admin/../app.js']) {
    const response = await request(path);
    assert.equal(response.status, 404, path);
  }
  // The shell itself is reachable by its file name as well as by directory index.
  assert.equal((await request('/admin/index.html')).status, 200);
});

test('admin UI accepts only GET and HEAD', async t => {
  const request = await serve(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await request('/admin/', { method });
    assert.equal(response.status, 405, method);
  }
  const head = await request('/admin/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('the shell has no inline script and only references existing assets', () => {
  const html = readAsset('index.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/u, 'inline <script> breaks script-src self');
  assert.doesNotMatch(html, /\son[a-z]+=/iu, 'inline event handlers break script-src self');
  assert.doesNotMatch(html, /javascript:/iu);
  assert.match(html, /<script type="module" src="\.\/js\/main\.js"><\/script>/u);
  assert.match(html, /name="robots" content="noindex, nofollow"/u);
  const referenced = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/gu)].map(match => match[1]);
  assert.ok(referenced.length >= 3);
  for (const asset of referenced) readFileSync(join(root, asset));
});

test('every navigation link in the shell resolves to a registered route', () => {
  const html = readAsset('index.html');
  const nav = [...html.matchAll(/href="#(\/[a-z-]+)"/gu)].map(match => match[1]);
  assert.ok(nav.includes('/apps'));
  const main = readAsset('js/main.js');
  const registered = new Set([...main.matchAll(/\['(\/[a-z-]+)', [A-Za-z]+View/gu)].map(match => match[1]).concat(
    [...main.matchAll(/route\('(\/[a-z-]+)'/gu)].map(match => match[1])));
  for (const path of nav) {
    if (path === '/') continue;
    assert.ok(registered.has(path), `navigation link ${path} has no route`);
  }
});

test('every relative module import resolves to a file inside the bundle', () => {
  const files = walk(root).filter(path => path.endsWith('.js'));
  assert.ok(files.length >= 10, 'bundle is expected to contain the view modules');
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from '(\.[^']+)'/gu)) {
      const target = join(dirname(file), match[1]);
      assert.ok(readFileSync(target, 'utf8').length > 0, `${relative(root, file)} imports missing ${match[1]}`);
      assert.ok(target.startsWith(root), 'imports must stay inside the bundle');
    }
  }
});

test('the bundle never embeds credentials and only talks to the documented API base', () => {
  for (const file of walk(root).filter(path => /\.(js|html|css)$/u.test(path))) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\bapiKey\s*[:=]\s*['"][^'"]{8,}/u, `${relative(root, file)} embeds a key`);
    assert.doesNotMatch(source, /\badminKey\s*[:=]\s*['"][^'"]{8,}/u, `${relative(root, file)} embeds a key`);
    assert.doesNotMatch(source, /MODERATION_APPS_JSON/u);
    assert.doesNotMatch(source, /localStorage\.(setItem|getItem)\([^)]*(key|token|session)/iu,
      `${relative(root, file)} must not persist secrets in web storage`);
  }
  const api = readAsset('js/api.js');
  assert.match(api, /export const BASE = '\/admin\/api';/u);
  assert.match(api, /credentials: 'same-origin'/u);
  assert.match(api, /X-CSRF-Token/u);
});

test('pages cover every administrative area required by the design', () => {
  const api = readAsset('js/api.js');
  for (const path of ['/setup', '/session', '/apps', '/keys', '/keywords', '/ip-rules', '/scenes',
    '/reviews', '/reports', '/audit', '/admins']) {
    assert.ok(api.includes(`'${path}`) || api.includes(`/${path.slice(1)}`), `api.js is missing ${path}`);
  }
  const html = readAsset('index.html');
  for (const marker of ['应用与密钥', '词库', 'IP 规则', '先审后发', '审核队列', '举报', '审计日志', '管理员']) {
    assert.ok(html.includes(marker), `navigation is missing ${marker}`);
  }
  const auth = readAsset('js/views/auth.js');
  assert.match(auth, /bootstrapStatus/u);
  assert.match(auth, /oidc/u);
});

test('every bundle module parses as an ES module', () => {
  const files = walk(root).filter(path => path.endsWith('.js'));
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${relative(root, file)}: ${result.stderr}`);
  }
});

test('the API client attaches the CSRF token to unsafe methods and drops it on 401', async () => {
  const calls = [];
  const responses = [];
  globalThis.window = { location: { origin: 'http://127.0.0.1:4310' } };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body),
      { status: next.status, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const { api, request, ENDPOINTS, setCsrfToken, getCsrfToken, setCurrentApp, ApiError } =
      await import('../../public/admin/js/api.js');
    // The token is published by the session endpoint; a write without it sends no header.
    setCsrfToken(null);
    responses.push({ status: 201, body: { app: { appId: 'alpha' } } });
    const created = await api.createApp({ appId: 'alpha' });
    assert.deepEqual(created, { app: { appId: 'alpha' } });
    assert.equal(calls[0].url, 'http://127.0.0.1:4310/admin/api/apps');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.equal(calls[0].init.headers['X-CSRF-Token'], undefined);
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');

    // With a token every unsafe call carries it.
    calls.length = 0;
    setCsrfToken('csrf-1');
    responses.push({ status: 200, body: { items: [], total: 0, limit: 10, offset: 0 } });
    await api.listApps({ limit: 10, offset: 0, q: 'alpha' });
    assert.equal(calls[0].init.headers['X-CSRF-Token'], undefined, 'safe methods never send a token');
    assert.match(calls[0].url, /limit=10&offset=0&q=alpha$/u);
    calls.length = 0;
    responses.push({ status: 201, body: {} });
    await api.createApp({ appId: 'beta' });
    assert.equal(calls[0].init.headers['X-CSRF-Token'], 'csrf-1');

    // A 401 clears the cached token.
    responses.push({ status: 401, body: { error: 'unauthorized', message: 'Login required', requestId: 'req-1' } });
    await assert.rejects(() => api.logout(), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 401);
      assert.equal(error.code, 'unauthorized');
      assert.equal(error.requestId, 'req-1');
      return true;
    });
    assert.equal(getCsrfToken(), null);

    // Route builders must encode operator input and scope tenant resources.
    assert.equal(ENDPOINTS.app('a b/c'), '/apps/a%20b%2Fc');
    assert.equal(ENDPOINTS.keyword('app 1', 'k/2'), '/apps/app%201/keywords/k%2F2');
    assert.equal(ENDPOINTS.scene('app', 'po st'), '/apps/app/scenes/po%20st');
    assert.throws(() => { setCurrentApp(null); api.listKeywords(); }, error => error.code === 'no_app_selected');
    setCurrentApp('app-1');
    calls.length = 0;
    responses.push({ status: 200, body: { items: [], total: 0, limit: 50, offset: 0 } });
    await api.listKeywords({ limit: 50 });
    assert.equal(calls[0].url, 'http://127.0.0.1:4310/admin/api/apps/app-1/keywords?limit=50');

    // The session payload is normalised for the views.
    calls.length = 0;
    responses.push({ status: 200, body: { admin: { username: 'root', role: 'super' }, csrfToken: 'csrf-2',
      expiresAt: '2026-11-04T00:00:00.000Z' } });
    responses.push({ status: 200, body: { items: [{ appId: 'app-1' }], total: 1, limit: 50, offset: 0 } });
    const session = await api.session();
    assert.equal(session.username, 'root');
    assert.equal(session.role, 'super');
    assert.deepEqual(session.apps, [{ appId: 'app-1' }]);
    assert.equal(getCsrfToken(), 'csrf-2');

    // An error from a write is surfaced without a cached token surviving.
    responses.push({ status: 400, body: { error: 'invalid_request', message: 'appId is required' } });
    await assert.rejects(() => request(ENDPOINTS.apps, { method: 'POST', body: {} }),
      error => error.code === 'invalid_request' && /appId is required/u.test(error.message));
    assert.equal(getCsrfToken(), 'csrf-2');
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});

test('word import parsing accepts lines, comma lists, and JSON payloads', async () => {
  globalThis.window = { location: { origin: 'http://127.0.0.1:4310' } };
  try {
    const { parseWords } = await import('../../public/admin/js/views/keywords.js');
    assert.deepEqual(parseWords('甲\n乙\n'), ['甲', '乙']);
    assert.deepEqual(parseWords('a，b,c;d\t e'), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(parseWords('["x","y"]'), ['x', 'y']);
    assert.deepEqual(parseWords('{"words":["x",{"word":"y"}]}'), ['x', 'y']);
    assert.deepEqual(parseWords('   '), []);
    assert.deepEqual(parseWords('{"broken":'), []);
  } finally {
    delete globalThis.window;
  }
});

test('list state round-trips through the hash query string', async () => {
  globalThis.window = { location: { origin: 'http://127.0.0.1:4310' } };
  try {
    const { listState, withQuery } = await import('../../public/admin/js/views/common.js');
    const state = listState(new URLSearchParams('category=custom&offset=50&limit=25'), { category: '' });
    assert.deepEqual(state, { category: 'custom', limit: 25, offset: 50 });
    assert.equal(withQuery('/keywords', state), '/keywords?category=custom&limit=25&offset=50');
    const defaults = listState(new URLSearchParams(''), { category: '' });
    assert.equal(withQuery('/keywords', defaults), '/keywords');
    const clamped = listState(new URLSearchParams('limit=1000&offset=-1'), {});
    assert.deepEqual(clamped, { limit: 50, offset: 0 });
  } finally {
    delete globalThis.window;
  }
});

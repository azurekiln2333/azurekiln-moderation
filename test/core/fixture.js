import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';

export const APPS = [
  { appId: 'alpha', apiKey: 'a'.repeat(40), adminKey: 'A'.repeat(40) },
  { appId: 'beta', apiKey: 'b'.repeat(40), adminKey: 'B'.repeat(40) }
];

const noPreReview = {
  initialize(ctx) {
    ctx.review = {
      requiresReview: () => false,
      enqueue: () => { throw new Error('Unexpected queue call'); }
    };
  },
  registerRoutes() {}
};

export const digest = value => createHash('sha256').update(value).digest('hex');

/** Inserts an application and its already-known plaintext keys directly, bypassing key minting. */
export function seedApps(ctx, apps = APPS, { seedKeywords = false } = {}) {
  ctx.transaction(() => {
    const now = ctx.now();
    const insertApp = ctx.db.prepare(`INSERT OR IGNORE INTO applications (app_id, created_at, name, status, updated_at)
      VALUES (?,?,?,'active',?)`);
    const insertKey = ctx.db.prepare(`INSERT OR IGNORE INTO app_keys (key_id, app_id, kind, token_hash, status, created_at)
      VALUES (?,?,?,?,'active',?)`);
    for (const app of apps) {
      insertApp.run(app.appId, now, app.appId, now);
      insertKey.run(randomUUID(), app.appId, 'api', digest(app.apiKey), now);
      insertKey.run(randomUUID(), app.appId, 'admin', digest(app.adminKey), now);
      if (seedKeywords) ctx.provisionKeywords(app.appId);
    }
  });
  ctx.appStore.invalidateAudienceCache();
  ctx.keywordMatcher?.invalidate();
}

export async function fixture(t, options = {}) {
  const quiet = { log: { info() {}, warn() {}, error() {} }, onSetupCode: setup => setup };
  const app = await createApp({ dbPath: ':memory:', seedKeywords: false,
    extensionModules: [noPreReview], ...quiet, ...options, apps: undefined });
  seedApps(app.locals.context, options.apps ?? APPS, { seedKeywords: options.seedKeywords === true });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
    app.locals.close();
  }
  t.after(close);
  async function request(path, { method = 'GET', body, role = 'api', appId = 'alpha', headers = {}, raw } = {}) {
    const config = (options.apps ?? APPS).find(item => item.appId === appId);
    const auth = role === null ? {} : { 'X-App-Id': appId, Authorization: `Bearer ${role === 'admin' ? config?.adminKey : config?.apiKey}` };
    const response = await fetch(baseUrl + path, {
      method, headers: { ...auth, ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { app, ctx: app.locals.context, request, baseUrl, close };
}

export const createKeyword = (request, body, appId = 'alpha') => request('/v1/admin/keywords', { method: 'POST', role: 'admin', appId, body });
export const checkText = (request, text, body = {}) => request('/v1/text/check', { method: 'POST', body: { scene: 'post', text, ...body } });
export const createRule = (request, body, appId = 'alpha') => request('/v1/admin/ip-rules', { method: 'POST', role: 'admin', appId, body });
export const checkIp = (request, ip) => request('/v1/ip/check', { method: 'POST', body: { scene: 'post', ip } });

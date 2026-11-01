import { once } from 'node:events';
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

export async function fixture(t, options = {}) {
  const app = await createApp({ apps: APPS, dbPath: ':memory:', seedKeywords: false,
    extensionModules: [noPreReview], ...options });
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
    const config = APPS.find(item => item.appId === appId);
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

// Admin UI API client. This file is the *only* place that knows the admin API shape.
// When docs/proposals/dynamic-config-contract.md lands, adjust ENDPOINTS below and the
// session/CSRF plumbing in `request`; no view should need to change.
//
// Conventions expected from the backend (see public/admin/README.md):
//   * every admin API lives under BASE; unauthenticated calls fail with 401 unauthorized;
//   * a session cookie authenticates the admin UI (HttpOnly, no token in JS);
//   * state-changing requests send the CSRF token from `GET /csrf` (or the
//     `csrfToken` field of `GET /session`) in the configured header;
//   * errors use the service envelope `{error,message,requestId}`.

export const BASE = '/admin/api';

export const ENDPOINTS = {
  csrf: '/csrf',
  session: '/session',
  login: '/login',
  logout: '/logout',
  password: '/password',
  bootstrap: '/bootstrap',
  bootstrapStatus: '/bootstrap/status',
  apps: '/apps',
  app: id => `/apps/${encodeURIComponent(id)}`,
  appDisable: id => `/apps/${encodeURIComponent(id)}/disable`,
  appEnable: id => `/apps/${encodeURIComponent(id)}/enable`,
  appKeys: id => `/apps/${encodeURIComponent(id)}/keys`,
  rotateKey: (id, kind) => `/apps/${encodeURIComponent(id)}/keys/${kind}/rotate`,
  revokeKey: (id, kind, keyId) => `/apps/${encodeURIComponent(id)}/keys/${kind}/${encodeURIComponent(keyId)}/revoke`,
  keywords: '/keywords',
  keyword: id => `/keywords/${encodeURIComponent(id)}`,
  keywordsImport: '/keywords/import',
  keywordsExport: '/keywords/export',
  ipRules: '/ip-rules',
  ipRule: id => `/ip-rules/${encodeURIComponent(id)}`,
  scenes: '/scenes',
  scene: scene => `/scenes/${encodeURIComponent(scene)}`,
  reviews: '/reviews',
  review: id => `/reviews/${encodeURIComponent(id)}`,
  resolveReview: id => `/reviews/${encodeURIComponent(id)}/resolve`,
  reports: '/reports',
  report: id => `/reports/${encodeURIComponent(id)}`,
  handleReport: id => `/reports/${encodeURIComponent(id)}/handle`,
  audit: '/audit',
  admins: '/admins',
  admin: id => `/admins/${encodeURIComponent(id)}`
};

export class ApiError extends Error {
  constructor(status, code, message, requestId) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

let csrfToken = null;

export function setCsrfToken(token) {
  csrfToken = typeof token === 'string' && token.length > 0 ? token : null;
}

export function getCsrfToken() {
  return csrfToken;
}

export async function refreshCsrf() {
  try {
    const body = await request(ENDPOINTS.csrf, { method: 'GET' });
    if (body && typeof body.csrfToken === 'string') setCsrfToken(body.csrfToken);
  } catch {
    setCsrfToken(null);
  }
  return csrfToken;
}

const unsafe = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function request(path, { method = 'GET', body, query, signal } = {}) {
  const url = new URL(BASE + path, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const headers = { Accept: 'application/json' };
  const init = { method, credentials: 'same-origin', headers, signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (unsafe.has(method)) {
    if (!csrfToken) await refreshCsrf();
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }
  if (!response.ok) {
    const code = payload?.error ?? `http_${response.status}`;
    const message = payload?.message ?? `请求失败（HTTP ${response.status}）`;
    if (response.status === 401) setCsrfToken(null);
    throw new ApiError(response.status, code, message, payload?.requestId);
  }
  return payload;
}

export const api = {
  session: () => request(ENDPOINTS.session),
  login: (username, password) => request(ENDPOINTS.login, { method: 'POST', body: { username, password } }),
  logout: () => request(ENDPOINTS.logout, { method: 'POST' }),
  changePassword: body => request(ENDPOINTS.password, { method: 'POST', body }),
  bootstrapStatus: () => request(ENDPOINTS.bootstrapStatus),
  bootstrap: body => request(ENDPOINTS.bootstrap, { method: 'POST', body }),

  listApps: query => request(ENDPOINTS.apps, { query }),
  createApp: body => request(ENDPOINTS.apps, { method: 'POST', body }),
  updateApp: (id, body) => request(ENDPOINTS.app(id), { method: 'PATCH', body }),
  deleteApp: id => request(ENDPOINTS.app(id), { method: 'DELETE' }),
  setAppEnabled: (id, enabled, body = {}) =>
    request(enabled ? ENDPOINTS.appEnable(id) : ENDPOINTS.appDisable(id), { method: 'POST', body }),
  rotateKey: (id, kind, body) => request(ENDPOINTS.rotateKey(id, kind), { method: 'POST', body }),
  revokeKey: (id, kind, keyId, body) => request(ENDPOINTS.revokeKey(id, kind, keyId), { method: 'POST', body }),

  listKeywords: query => request(ENDPOINTS.keywords, { query }),
  createKeyword: body => request(ENDPOINTS.keywords, { method: 'POST', body }),
  updateKeyword: (id, body) => request(ENDPOINTS.keyword(id), { method: 'PATCH', body }),
  deleteKeyword: id => request(ENDPOINTS.keyword(id), { method: 'DELETE' }),
  importKeywords: body => request(ENDPOINTS.keywordsImport, { method: 'POST', body }),
  exportKeywords: query => request(ENDPOINTS.keywordsExport, { query }),

  listIpRules: query => request(ENDPOINTS.ipRules, { query }),
  createIpRule: body => request(ENDPOINTS.ipRules, { method: 'POST', body }),
  updateIpRule: (id, body) => request(ENDPOINTS.ipRule(id), { method: 'PATCH', body }),
  deleteIpRule: id => request(ENDPOINTS.ipRule(id), { method: 'DELETE' }),

  listScenes: query => request(ENDPOINTS.scenes, { query }),
  getScene: scene => request(ENDPOINTS.scene(scene)),
  setScene: (scene, body) => request(ENDPOINTS.scene(scene), { method: 'PUT', body }),

  listReviews: query => request(ENDPOINTS.reviews, { query }),
  getReview: id => request(ENDPOINTS.review(id)),
  resolveReview: (id, body) => request(ENDPOINTS.resolveReview(id), { method: 'POST', body }),

  listReports: query => request(ENDPOINTS.reports, { query }),
  getReport: id => request(ENDPOINTS.report(id)),
  handleReport: (id, body) => request(ENDPOINTS.handleReport(id), { method: 'POST', body }),

  listAudit: query => request(ENDPOINTS.audit, { query }),

  listAdmins: query => request(ENDPOINTS.admins, { query }),
  createAdmin: body => request(ENDPOINTS.admins, { method: 'POST', body }),
  updateAdmin: (id, body) => request(ENDPOINTS.admin(id), { method: 'PATCH', body }),
  deleteAdmin: id => request(ENDPOINTS.admin(id), { method: 'DELETE' })
};

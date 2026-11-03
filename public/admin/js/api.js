// Admin UI API client — the only module that knows the admin API shape.
// It maps the view-level operations onto the frozen contract in
// docs/proposals/dynamic-config-contract.md (§5). Views never build URLs.
//
// Conventions from the contract:
//   * the session cookie authenticates every call; the CSRF token travels in
//     `X-CSRF-Token` on writes and is returned by `GET /admin/api/session`;
//   * tenant resources live under `/admin/api/apps/:appId/...`, so the client
//     tracks the currently selected application;
//   * errors use the service envelope `{error,message,requestId}`.

export const BASE = '/admin/api';

export class ApiError extends Error {
  constructor(status, code, message, requestId) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

const enc = encodeURIComponent;

/** Path templates for the endpoints documented in the contract. */
export const ENDPOINTS = {
  setup: '/setup',
  authConfig: '/auth/config',
  session: '/session',
  password: '/session/password',
  revokeAll: '/session/revoke-all',
  oidcStart: '/auth/oidc/start',
  meta: '/meta',
  apps: '/apps',
  app: id => `/apps/${enc(id)}`,
  appKeys: id => `/apps/${enc(id)}/keys`,
  rotateKeys: id => `/apps/${enc(id)}/keys/rotate`,
  revokeKeys: id => `/apps/${enc(id)}/keys/revoke`,
  keywords: id => `/apps/${enc(id)}/keywords`,
  keyword: (id, keyId) => `/apps/${enc(id)}/keywords/${enc(keyId)}`,
  keywordsExport: id => `/apps/${enc(id)}/keywords/export`,
  keywordsImport: id => `/apps/${enc(id)}/keywords/import`,
  ipRules: id => `/apps/${enc(id)}/ip-rules`,
  ipRule: (id, ruleId) => `/apps/${enc(id)}/ip-rules/${enc(ruleId)}`,
  scenes: id => `/apps/${enc(id)}/scenes`,
  scene: (id, scene) => `/apps/${enc(id)}/scenes/${enc(scene)}`,
  reviews: id => `/apps/${enc(id)}/reviews`,
  review: (id, reviewId) => `/apps/${enc(id)}/reviews/${enc(reviewId)}`,
  resolveReview: (id, reviewId) => `/apps/${enc(id)}/reviews/${enc(reviewId)}/resolve`,
  reports: id => `/apps/${enc(id)}/reports`,
  report: (id, reportId) => `/apps/${enc(id)}/reports/${enc(reportId)}`,
  handleReport: (id, reportId) => `/apps/${enc(id)}/reports/${enc(reportId)}/handle`,
  audit: id => `/apps/${enc(id)}/audit`,
  admins: '/admins',
  admin: id => `/admins/${enc(id)}`,
  adminPassword: id => `/admins/${enc(id)}/password`,
  oidcSettings: '/settings/oidc'
};

let csrfToken = null;
let currentApp = null;

export function setCsrfToken(token) {
  csrfToken = typeof token === 'string' && token.length > 0 ? token : null;
}

export function getCsrfToken() {
  return csrfToken;
}

/** Selects the tenant every scoped call below operates on. */
export function setCurrentApp(appId) {
  currentApp = typeof appId === 'string' && appId.length > 0 ? appId : null;
  return currentApp;
}

export function getCurrentApp() {
  return currentApp;
}

function appScoped() {
  if (!currentApp) {
    throw new ApiError(400, 'no_app_selected', '请先在“应用与密钥”中选择一个应用');
  }
  return currentApp;
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
  if (unsafe.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
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

/** Session payload normalised for the views: who am I, CSRF token, and the tenant list. */
async function loadSession() {
  const body = await request(ENDPOINTS.session);
  if (!body) return null;
  if (body.csrfToken) setCsrfToken(body.csrfToken);
  const admin = body.admin ?? {};
  let apps = [];
  try {
    const listed = await request(ENDPOINTS.apps);
    apps = Array.isArray(listed?.items) ? listed.items : [];
  } catch { /* a role without app visibility still gets a session */ }
  return {
    ...body,
    username: admin.username,
    role: admin.role,
    displayName: admin.displayName,
    admin,
    apps,
    appId: currentApp
  };
}

/** Re-reads the CSRF token; used after login and when the token is rejected. */
export async function refreshCsrf() {
  try {
    const body = await request(ENDPOINTS.session);
    if (body?.csrfToken) setCsrfToken(body.csrfToken);
  } catch {
    setCsrfToken(null);
  }
  return csrfToken;
}

export const api = {
  // --- authentication and setup -------------------------------------------
  session: () => loadSession(),
  login: async (username, password) => {
    const body = await request(ENDPOINTS.session, { method: 'POST', body: { username, password } });
    if (body?.csrfToken) setCsrfToken(body.csrfToken);
    return body;
  },
  logout: () => request(ENDPOINTS.session, { method: 'DELETE' }),
  changePassword: body => request(ENDPOINTS.password, { method: 'POST', body }),
  revokeAll: () => request(ENDPOINTS.revokeAll, { method: 'POST' }),
  authConfig: () => request(ENDPOINTS.authConfig),
  setupStatus: () => request(ENDPOINTS.setup),
  bootstrapStatus: () => request(ENDPOINTS.setup),
  bootstrap: (body = {}) => request(ENDPOINTS.setup, { method: 'POST', body }),
  meta: () => request(ENDPOINTS.meta),

  // --- applications and keys ----------------------------------------------
  listApps: query => request(ENDPOINTS.apps, { query }),
  createApp: body => request(ENDPOINTS.apps, { method: 'POST', body }),
  getApp: id => request(ENDPOINTS.app(id)),
  updateApp: (id, body) => request(ENDPOINTS.app(id), { method: 'PATCH', body }),
  deleteApp: id => request(ENDPOINTS.app(id), { method: 'DELETE' }),
  setAppEnabled: (id, enabled) => request(ENDPOINTS.app(id), { method: 'PATCH',
    body: { status: enabled ? 'active' : 'disabled' } }),
  listKeys: id => request(ENDPOINTS.appKeys(id)),
  issueKeys: (id, body) => request(ENDPOINTS.appKeys(id), { method: 'POST', body }),
  rotateKey: (id, _kind, body) => request(ENDPOINTS.rotateKeys(id), { method: 'POST', body }),
  revokeKey: (id, _kind, _keyId, body) => request(ENDPOINTS.revokeKeys(id), { method: 'POST', body }),

  // --- dictionary ----------------------------------------------------------
  listKeywords: query => request(ENDPOINTS.keywords(appScoped()), { query }),
  createKeyword: body => request(ENDPOINTS.keywords(appScoped()), { method: 'POST', body }),
  updateKeyword: (id, body) => request(ENDPOINTS.keyword(appScoped(), id), { method: 'PATCH', body }),
  deleteKeyword: id => request(ENDPOINTS.keyword(appScoped(), id), { method: 'DELETE' }),
  importKeywords: body => request(ENDPOINTS.keywordsImport(appScoped()), { method: 'POST', body }),
  exportKeywords: () => request(ENDPOINTS.keywordsExport(appScoped())),

  // --- IP rules ------------------------------------------------------------
  listIpRules: query => request(ENDPOINTS.ipRules(appScoped()), { query }),
  createIpRule: body => request(ENDPOINTS.ipRules(appScoped()), { method: 'POST', body }),
  updateIpRule: (id, body) => request(ENDPOINTS.ipRule(appScoped(), id), { method: 'PATCH', body }),
  deleteIpRule: id => request(ENDPOINTS.ipRule(appScoped(), id), { method: 'DELETE' }),

  // --- pre-review policies -------------------------------------------------
  listScenes: query => request(ENDPOINTS.scenes(appScoped()), { query }),
  getScene: scene => request(ENDPOINTS.scene(appScoped(), scene)),
  setScene: (scene, body) => request(ENDPOINTS.scene(appScoped(), scene), { method: 'PUT', body }),

  // --- review queue --------------------------------------------------------
  listReviews: query => request(ENDPOINTS.reviews(appScoped()), { query }),
  getReview: id => request(ENDPOINTS.review(appScoped(), id)),
  resolveReview: (id, body) => request(ENDPOINTS.resolveReview(appScoped(), id), { method: 'POST', body }),

  // --- reports -------------------------------------------------------------
  listReports: query => request(ENDPOINTS.reports(appScoped()), { query }),
  getReport: id => request(ENDPOINTS.report(appScoped(), id)),
  handleReport: (id, body) => request(ENDPOINTS.handleReport(appScoped(), id), { method: 'POST', body }),

  // --- audit ---------------------------------------------------------------
  listAudit: query => request(ENDPOINTS.audit(appScoped()), { query }),

  // --- administrators ------------------------------------------------------
  listAdmins: query => request(ENDPOINTS.admins, { query }),
  createAdmin: body => request(ENDPOINTS.admins, { method: 'POST', body }),
  updateAdmin: (id, body) => request(ENDPOINTS.admin(id), { method: 'PATCH', body }),
  resetAdminPassword: (id, body) => request(ENDPOINTS.adminPassword(id), { method: 'POST', body }),
  deleteAdmin: id => request(ENDPOINTS.admin(id), { method: 'DELETE' }),

  // --- optional OIDC -------------------------------------------------------
  getOidc: () => request(ENDPOINTS.oidcSettings),
  setOidc: body => request(ENDPOINTS.oidcSettings, { method: 'PUT', body }),
  deleteOidc: () => request(ENDPOINTS.oidcSettings, { method: 'DELETE' })
};

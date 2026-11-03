import { httpError } from './errors.js';

export const LEGACY_KEY_MIN = 32;
export const LEGACY_KEY_MAX = 512;
const APP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parses the legacy MODERATION_APPS_JSON payload for one-time import.
 * Returns an empty list when unset. Keys are validated but only hashes are persisted.
 */
export function parseLegacyApps(value) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return [];
  let apps = value;
  if (typeof value === 'string') {
    try { apps = JSON.parse(value); } catch { throw new Error('MODERATION_APPS_JSON must contain valid JSON'); }
  }
  if (!Array.isArray(apps)) throw new Error('MODERATION_APPS_JSON must be a JSON array');
  const ids = new Set();
  const keys = new Set();
  return apps.map(app => {
    if (!app || typeof app.appId !== 'string' || !APP_ID_PATTERN.test(app.appId) || ids.has(app.appId)) {
      throw new Error('App IDs must be unique safe identifiers');
    }
    ids.add(app.appId);
    for (const key of [app.apiKey, app.adminKey]) {
      if (typeof key !== 'string' || key.length < LEGACY_KEY_MIN || key.length > LEGACY_KEY_MAX ||
          /\s/.test(key) || keys.has(key)) {
        throw new Error('All API/admin keys must be unique, non-whitespace secrets of 32..512 characters');
      }
      keys.add(key);
    }
    return Object.freeze({ appId: app.appId, apiKey: app.apiKey, adminKey: app.adminKey });
  });
}

export function authenticate(ctx) {
  const store = ctx.appStore;
  return (req, _res, next) => {
    const appId = req.get('X-App-Id');
    const token = /^Bearer ([^\s]+)$/.exec(req.get('Authorization') ?? '')?.[1];
    if (!appId || !token) throw httpError(401, 'unauthorized', 'Invalid app credentials');
    const role = store.resolveToken(appId, token);
    if (!role) throw httpError(401, 'unauthorized', 'Invalid app credentials');
    req.auth = Object.freeze({ appId, isAdmin: role === 'admin' });
    next();
  };
}

export function requireAdmin(req, _res, next) {
  if (!req.auth?.isAdmin) throw httpError(403, 'forbidden', 'App admin credentials required');
  next();
}

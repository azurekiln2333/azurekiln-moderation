import { createHash, timingSafeEqual } from 'node:crypto';
import { httpError } from './errors.js';

const digest = value => createHash('sha256').update(value).digest();

export function configureApps(value) {
  let apps = value;
  if (typeof value === 'string') {
    try { apps = JSON.parse(value); } catch { throw new Error('MODERATION_APPS_JSON must contain valid JSON'); }
  }
  if (!Array.isArray(apps) || apps.length === 0) throw new Error('Configure at least one moderation app');
  const ids = new Set();
  const keys = new Set();
  return new Map(apps.map(app => {
    if (!app || typeof app.appId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(app.appId) || ids.has(app.appId)) {
      throw new Error('App IDs must be unique safe identifiers');
    }
    ids.add(app.appId);
    for (const key of [app.apiKey, app.adminKey]) {
      if (typeof key !== 'string' || key.length < 32 || key.length > 512 || /\s/.test(key) || keys.has(key)) {
        throw new Error('All API/admin keys must be unique, non-whitespace secrets of 32..512 characters');
      }
      keys.add(key);
    }
    return [app.appId, { api: digest(app.apiKey), admin: digest(app.adminKey) }];
  }));
}

export function authenticate(apps) {
  return (req, _res, next) => {
    const appId = req.get('X-App-Id');
    const token = /^Bearer ([^\s]+)$/.exec(req.get('Authorization') ?? '')?.[1];
    const app = apps.get(appId);
    if (!app || !token || token.length > 512) throw httpError(401, 'unauthorized', 'Invalid app credentials');
    const presented = digest(token);
    const isAdmin = timingSafeEqual(presented, app.admin);
    const isApi = timingSafeEqual(presented, app.api);
    if (!isAdmin && !isApi) throw httpError(401, 'unauthorized', 'Invalid app credentials');
    req.auth = Object.freeze({ appId, isAdmin });
    next();
  };
}

export function requireAdmin(req, _res, next) {
  if (!req.auth?.isAdmin) throw httpError(403, 'forbidden', 'App admin credentials required');
  next();
}

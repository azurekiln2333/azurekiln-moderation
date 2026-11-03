import { randomUUID } from 'node:crypto';
import { generateToken, sha256Hex, KEY_GRACE_MAX_MS, KEY_GRACE_MIN_MS, DEFAULT_KEY_GRACE_MS } from './crypto.js';

/**
 * Applications and credentials for the admin API (contract §4, §5.2).
 *
 * Core owns this data layer (`src/config/store.js`, exposed as `ctx.appStore`).
 * The admin routes use it whenever it is present. The fallback below implements
 * the identical interface over the same `applications` / `app_keys` tables so
 * this module still runs standalone (unit tests, partial checkouts). Keep the
 * two in step: same method names, same return shapes, same error codes.
 */
export const SYSTEM_APP_ID = '_system';
const APP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_GRACE_DEFAULT_MS = DEFAULT_KEY_GRACE_MS;

function appRow(row) {
  return {
    appId: row.app_id,
    name: row.name ?? null,
    status: row.status ?? 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at
  };
}

function keyRow(row) {
  return {
    keyId: row.key_id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at
  };
}

function invalid(message, status = 'invalid_request', code = 400) {
  return Object.assign(new Error(message), { status: code, error: status });
}

function assertAppId(appId) {
  if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId) || appId === SYSTEM_APP_ID) {
    throw invalid('appId must be a safe identifier of 1..64 characters');
  }
  return appId;
}

function normalizeName(name) {
  if (name === undefined || name === null) return null;
  if (typeof name !== 'string' || [...name.trim()].length === 0 || [...name].length > 128) {
    throw invalid('name must be a string of 1..128 characters');
  }
  return name.trim();
}

export function resolveGraceMs(value, fallback = KEY_GRACE_DEFAULT_MS) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < KEY_GRACE_MIN_MS || value > KEY_GRACE_MAX_MS) {
    throw invalid(`graceMs must be an integer between ${KEY_GRACE_MIN_MS} and ${KEY_GRACE_MAX_MS}`);
  }
  return value;
}

/** Fallback implementation matching core's store interface. */
export function createFallbackStore(ctx) {
  const statements = {
    insertApp: ctx.db.prepare('INSERT INTO applications (app_id, created_at, name, status, updated_at) VALUES (?,?,?,?,?)'),
    selectApp: ctx.db.prepare('SELECT * FROM applications WHERE app_id=?'),
    selectApps: ctx.db.prepare('SELECT * FROM applications WHERE app_id<>? ORDER BY created_at, app_id'),
    updateApp: ctx.db.prepare('UPDATE applications SET name=?, status=?, updated_at=? WHERE app_id=?'),
    deleteApp: ctx.db.prepare('DELETE FROM applications WHERE app_id=?'),
    insertKey: ctx.db.prepare(`INSERT INTO app_keys (key_id, app_id, kind, token_hash, status, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?)`),
    selectKeys: ctx.db.prepare('SELECT * FROM app_keys WHERE app_id=? ORDER BY created_at, key_id'),
    selectLive: ctx.db.prepare(`SELECT * FROM app_keys WHERE app_id=? AND status IN ('active','grace')
      ORDER BY created_at DESC`),
    revokeKey: ctx.db.prepare(`UPDATE app_keys SET status='revoked', revoked_at=?, revoked_reason=?
      WHERE key_id=? AND status<>'revoked'`),
    expireGrace: ctx.db.prepare(`UPDATE app_keys SET status='revoked', revoked_at=expires_at
      WHERE status='grace' AND expires_at IS NOT NULL AND expires_at<=?`)
  };

  function mintKeys(appId, options = {}) {
    const grace = resolveGraceMs(options.graceMs);
    const now = ctx.now();
    const graceUntil = new Date(new Date(now).getTime() + grace).toISOString();
    const plaintext = { apiKey: generateToken(), adminKey: generateToken() };
    ctx.transaction(() => {
      for (const kind of ['api', 'admin']) {
        ctx.db.prepare(`UPDATE app_keys SET status='grace', expires_at=?
          WHERE app_id=? AND kind=? AND status='active'`).run(graceUntil, appId, kind);
      }
      statements.insertKey.run(randomUUID(), appId, 'api', sha256Hex(plaintext.apiKey), 'active', now, null);
      statements.insertKey.run(randomUUID(), appId, 'admin', sha256Hex(plaintext.adminKey), 'active', now, null);
    });
    return { ...plaintext, graceUntil };
  }

  return {
    SYSTEM_APP_ID,
    listApps({ status } = {}) {
      return statements.selectApps.all(SYSTEM_APP_ID).map(appRow).filter(row => !status || row.status === status);
    },
    getApp(appId) {
      if (appId === SYSTEM_APP_ID) {
        return { appId: SYSTEM_APP_ID, name: 'System', status: 'disabled', createdAt: null, updatedAt: null };
      }
      const row = statements.selectApp.get(appId);
      return row ? appRow(row) : null;
    },
    createApp(input = {}) {
      const appId = assertAppId(input.appId);
      const name = normalizeName(input.name);
      const now = ctx.now();
      ctx.transaction(() => {
        if (statements.selectApp.get(appId)) throw invalid('The application already exists', 'conflict', 409);
        statements.insertApp.run(appId, now, name, 'active', now);
      });
      return appRow(statements.selectApp.get(appId));
    },
    updateApp(appId, patch = {}) {
      assertAppId(appId);
      const current = statements.selectApp.get(appId);
      if (!current) return null;
      const name = Object.hasOwn(patch, 'name') ? normalizeName(patch.name) : (current.name ?? null);
      let status = current.status;
      if (Object.hasOwn(patch, 'status')) {
        if (!['active', 'disabled'].includes(patch.status)) throw invalid('status is not a supported value');
        status = patch.status;
      }
      statements.updateApp.run(name, status, ctx.now(), appId);
      return appRow(statements.selectApp.get(appId));
    },
    deleteApp(appId) {
      assertAppId(appId);
      if (!statements.selectApp.get(appId)) return null;
      ctx.transaction(() => {
        for (const table of ['keywords', 'ip_rules', 'audit_events', 'review_policies', 'review_items',
          'image_decisions', 'reports', 'report_events']) {
          try { ctx.db.prepare(`DELETE FROM ${table} WHERE app_id=?`).run(appId); } catch (error) {
            if (!/no such table/.test(error.message)) throw error;
          }
        }
        ctx.db.prepare('DELETE FROM app_keys WHERE app_id=?').run(appId);
        statements.deleteApp.run(appId);
      });
      return { deleted: true };
    },
    issueKeys(appId, options) {
      if (!statements.selectApp.get(appId)) return null;
      return mintKeys(appId, options);
    },
    rotateKeys(appId, options) {
      if (!statements.selectApp.get(appId)) return null;
      return mintKeys(appId, options);
    },
    revokeKeys(appId, { reason } = {}) {
      if (!statements.selectApp.get(appId)) return null;
      const why = typeof reason === 'string' && reason.length <= 128 ? reason : 'revoked';
      const now = ctx.now();
      for (const row of statements.selectLive.all(appId)) statements.revokeKey.run(now, why, row.key_id);
      return { revoked: true };
    },
    listKeys(appId) {
      if (!statements.selectApp.get(appId)) return null;
      const now = ctx.now();
      return statements.selectKeys.all(appId).map(row => (
        row.status === 'grace' && row.expires_at && row.expires_at <= now
          ? keyRow({ ...row, status: 'revoked', revoked_at: row.expires_at })
          : keyRow(row)
      ));
    },
    keySummary(appId) {
      const summary = { api: 'none', admin: 'none' };
      for (const row of statements.selectLive.all(appId)) {
        if (row.status === 'active') summary[row.kind] = 'active';
        else if (summary[row.kind] === 'none') summary[row.kind] = 'grace';
      }
      return summary;
    },
    resolveToken(appId, token) {
      if (typeof appId !== 'string' || typeof token !== 'string' || token.length === 0 || token.length > 512) return null;
      const app = statements.selectApp.get(appId);
      if (!app || app.status !== 'active') return null;
      const hash = sha256Hex(token);
      const now = ctx.now();
      for (const row of statements.selectLive.all(appId)) {
        if (row.token_hash !== hash) continue;
        if (row.status === 'grace' && row.expires_at && row.expires_at <= now) continue;
        return row.kind === 'admin' ? 'admin' : 'api';
      }
      return null;
    },
    expireGraceWindows() {
      return Number(statements.expireGrace.run(ctx.now()).changes);
    },
    invalidateAudienceCache() {}
  };
}

/** Returns core's store when present, otherwise the identical fallback. */
export function resolveStore(ctx) {
  return ctx.appStore ?? createFallbackStore(ctx);
}

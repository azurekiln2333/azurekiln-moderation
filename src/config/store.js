import { randomUUID } from 'node:crypto';
import { generateToken, safeEqualHex, sha256Hex } from '../crypto.js';

export const SYSTEM_APP_ID = '_system';
export const APP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const KEY_GRACE_DEFAULT_MS = 3_600_000;
export const KEY_GRACE_MIN_MS = 60_000;
export const KEY_GRACE_MAX_MS = 604_800_000;
export const AUDIENCE_CACHE_MS = 5_000;

const SYSTEM_APP = Object.freeze({ appId: SYSTEM_APP_ID, name: 'System', status: 'disabled' });

function appRow(row) {
  return { appId: row.app_id, name: row.name ?? null, status: row.status, createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at };
}

function keyRow(row) {
  return { keyId: row.key_id, kind: row.kind, status: row.status, createdAt: row.created_at,
    expiresAt: row.expires_at, revokedAt: row.revoked_at, lastUsedAt: row.last_used_at };
}

function assertAppId(appId) {
  if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId) || appId === SYSTEM_APP_ID) {
    throw Object.assign(new Error('appId must be a safe identifier of 1..64 characters'), { status: 400, error: 'invalid_request' });
  }
}

function normalizeName(name) {
  if (name === undefined || name === null) return null;
  if (typeof name !== 'string' || [...name.trim()].length === 0 || [...name].length > 128) {
    throw Object.assign(new Error('name must be a string of 1..128 characters'), { status: 400, error: 'invalid_request' });
  }
  return name.trim();
}

export function createAppStore(ctx) {
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
      WHERE status='grace' AND expires_at IS NOT NULL AND expires_at<=?`),
    touchKey: ctx.db.prepare('UPDATE app_keys SET last_used_at=? WHERE key_id=?'),
    selectByHash: ctx.db.prepare('SELECT * FROM app_keys WHERE token_hash=?'),
    countKeys: ctx.db.prepare(`SELECT kind, status, COUNT(*) AS n FROM app_keys WHERE app_id=?
      AND status IN ('active','grace') GROUP BY kind, status`)
  };

  const cache = new Map();

  function invalidateAudienceCache(appId) {
    if (appId === undefined) cache.clear();
    else cache.delete(appId);
  }

  function graceMs(value) {
    if (value === undefined || value === null) return KEY_GRACE_DEFAULT_MS;
    if (!Number.isSafeInteger(value) || value < KEY_GRACE_MIN_MS || value > KEY_GRACE_MAX_MS) {
      throw Object.assign(new Error('graceMs is out of range'), { status: 400, error: 'invalid_request' });
    }
    return value;
  }

  function mintKeys(appId, options = {}) {
    const grace = graceMs(options.graceMs);
    const now = ctx.now();
    const graceUntil = new Date(new Date(now).getTime() + grace).toISOString();
    const plaintext = { apiKey: generateToken(), adminKey: generateToken() };
    ctx.transaction(() => {
      // Retire the previous active secrets into the grace window.
      for (const kind of ['api', 'admin']) {
        ctx.db.prepare(`UPDATE app_keys SET status='grace', expires_at=? WHERE app_id=? AND kind=? AND status='active'`)
          .run(graceUntil, appId, kind);
      }
      statements.insertKey.run(randomUUID(), appId, 'api', sha256Hex(plaintext.apiKey), 'active', now, null);
      statements.insertKey.run(randomUUID(), appId, 'admin', sha256Hex(plaintext.adminKey), 'active', now, null);
    });
    invalidateAudienceCache(appId);
    return { ...plaintext, graceUntil };
  }

  function createApp(input = {}) {
    const appId = input.appId;
    assertAppId(appId);
    const name = normalizeName(input.name);
    const now = ctx.now();
    ctx.transaction(() => {
      if (statements.selectApp.get(appId)) {
        throw Object.assign(new Error('The application already exists'), { status: 409, error: 'conflict' });
      }
      statements.insertApp.run(appId, now, name, 'active', now);
    });
    invalidateAudienceCache(appId);
    if (input.seedKeywords !== false && typeof ctx.provisionAppKeywords === 'function') {
      ctx.provisionAppKeywords(appId);
    }
    return appRow(statements.selectApp.get(appId));
  }

  function loadAudience(appId, token) {
    let entry = cache.get(appId);
    // The monotonic access clock only controls the cache lifetime; key validity uses the business clock.
    const time = ctx.accessClock ? ctx.accessClock() : Date.now();
    if (!entry || time - entry.loadedAt >= AUDIENCE_CACHE_MS || time < entry.loadedAt) {
      const row = statements.selectApp.get(appId);
      entry = {
        loadedAt: time,
        status: row ? row.status : null,
        keys: row ? statements.selectLive.all(appId) : []
      };
      cache.set(appId, entry);
    }
    if (entry.status !== 'active') return null;
    const hash = sha256Hex(token);
    const now = ctx.now();
    let role = null;
    for (const key of entry.keys) {
      if (!safeEqualHex(key.token_hash, hash)) continue;
      if (key.status === 'revoked') return null;
      if (key.status === 'grace' && key.expires_at && key.expires_at <= now) continue;
      role = key.kind === 'admin' ? 'admin' : 'api';
      statements.touchKey.run(now, key.key_id);
    }
    return role;
  }

  return {
    SYSTEM_APP,
    systemApp: () => SYSTEM_APP,
    listApps({ status } = {}) {
      return statements.selectApps.all(SYSTEM_APP_ID).map(appRow)
        .filter(row => !status || row.status === status);
    },
    getApp(appId) {
      if (appId === SYSTEM_APP_ID) return { ...SYSTEM_APP };
      const row = statements.selectApp.get(appId);
      return row ? appRow(row) : null;
    },
    createApp,
    updateApp(appId, patch = {}) {
      assertAppId(appId);
      const current = statements.selectApp.get(appId);
      if (!current) return null;
      const name = Object.hasOwn(patch, 'name') ? normalizeName(patch.name) : (current.name ?? null);
      let status = current.status;
      if (Object.hasOwn(patch, 'status')) {
        if (!['active', 'disabled'].includes(patch.status)) {
          throw Object.assign(new Error('status is not a supported value'), { status: 400, error: 'invalid_request' });
        }
        status = patch.status;
      }
      statements.updateApp.run(name, status, ctx.now(), appId);
      invalidateAudienceCache(appId);
      return appRow(statements.selectApp.get(appId));
    },
    deleteApp(appId) {
      assertAppId(appId);
      const exists = statements.selectApp.get(appId);
      if (!exists) return null;
      ctx.transaction(() => {
        for (const table of ['keywords', 'ip_rules', 'audit_events', 'review_policies', 'review_items',
          'image_decisions', 'reports']) {
          try { ctx.db.prepare(`DELETE FROM ${table} WHERE app_id=?`).run(appId); } catch (error) {
            if (!/no such table/.test(error.message)) throw error;
          }
        }
        statements.deleteApp.run(appId);
      });
      invalidateAudienceCache(appId);
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
      invalidateAudienceCache(appId);
      return { revoked: true };
    },
    listKeys(appId) {
      if (!statements.selectApp.get(appId)) return null;
      const now = ctx.now();
      return statements.selectKeys.all(appId).map(row => {
        if (row.status === 'grace' && row.expires_at && row.expires_at <= now) {
          return keyRow({ ...row, status: 'revoked', revoked_at: row.expires_at });
        }
        return keyRow(row);
      });
    },
    keySummary(appId) {
      const rows = statements.countKeys.all(appId);
      const summary = { api: 'none', admin: 'none' };
      for (const row of rows) {
        if (row.status === 'active') summary[row.kind] = 'active';
        else if (summary[row.kind] === 'none') summary[row.kind] = 'grace';
      }
      return summary;
    },
    resolveToken(appId, token) {
      if (typeof appId !== 'string' || typeof token !== 'string' || token.length === 0 || token.length > 512) return null;
      return loadAudience(appId, token);
    },
    expireGraceWindows() {
      return Number(statements.expireGrace.run(ctx.now()).changes);
    },
    invalidateAudienceCache,
    findByHash(token) {
      return statements.selectByHash.get(sha256Hex(token)) ?? null;
    }
  };
}

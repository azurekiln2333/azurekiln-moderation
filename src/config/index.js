import { createHash, randomUUID } from 'node:crypto';
import { ensureSetupCode, setupState } from '../admin-auth.js';
import { parseLegacyApps } from '../auth.js';
import { createAppStore, SYSTEM_APP_ID } from './store.js';

const digest = value => createHash('sha256').update(value).digest('hex');

/**
 * Imports MODERATION_APPS_JSON once.
 *
 * Applications that already exist are never overwritten, because the operator may have
 * rotated keys through the console. Two cases still need the legacy secrets:
 *   - a brand new application           -> created with the imported keys;
 *   - an upgraded application with no keys yet (its keys lived only in the environment
 *     variable until this release)      -> the legacy keys are attached, so consumers keep
 *     working without an outage.
 * An application that already owns keys is left untouched and reported as skipped.
 * Only hashes are stored; the plaintext never reaches the database.
 */
export function importLegacyApps(ctx, value, { log = console } = {}) {
  let apps;
  try {
    apps = parseLegacyApps(value);
  } catch {
    log.error(JSON.stringify({ event: 'moderation.apps_import_failed' }));
    return { created: [], adopted: [], skipped: [], failed: true };
  }
  if (apps.length === 0) return { created: [], adopted: [], skipped: [], failed: false };
  const inserted = [];
  const adopted = [];
  const skipped = [];
  for (const app of apps) {
    const existing = ctx.appStore.getApp(app.appId);
    const live = existing ? ctx.db.prepare(`SELECT COUNT(*) AS n FROM app_keys
      WHERE app_id=? AND status IN ('active','grace')`).get(app.appId).n : 0;
    if (existing && live > 0) {
      skipped.push(app.appId);
      continue;
    }
    if (!existing) ctx.appStore.createApp({ appId: app.appId, name: app.appId });
    const now = ctx.now();
    ctx.transaction(() => {
      ctx.db.prepare(`INSERT INTO app_keys (key_id, app_id, kind, token_hash, status, created_at)
        VALUES (?,?,'api',?,'active',?)`).run(randomUUID(), app.appId, digest(app.apiKey), now);
      ctx.db.prepare(`INSERT INTO app_keys (key_id, app_id, kind, token_hash, status, created_at)
        VALUES (?,?,'admin',?,'active',?)`).run(randomUUID(), app.appId, digest(app.adminKey), now);
    });
    ctx.appStore.invalidateAudienceCache(app.appId);
    if (existing) adopted.push(app.appId);
    else inserted.push(app.appId);
  }
  if (inserted.length) {
    log.info(JSON.stringify({ event: 'moderation.apps_imported', created: inserted, skipped }));
  }
  if (adopted.length) {
    log.info(JSON.stringify({ event: 'moderation.apps_import_keys', adopted }));
  }
  if (skipped.length) {
    log.info(JSON.stringify({ event: 'moderation.apps_import_skipped', skipped }));
  }
  log.warn(JSON.stringify({ event: 'moderation.config_env_deprecated',
    hint: 'MODERATION_APPS_JSON has been imported into the database and can be removed' }));
  return { created: inserted, adopted, skipped, failed: false };
}

/** Ensures the internal audit tenant exists, builds the app store, and wires configuration hooks. */
export function initializeConfig(ctx) {
  ctx.transaction(() => {
    const now = ctx.now();
    ctx.db.prepare(`INSERT OR IGNORE INTO applications (app_id, created_at, name, status, updated_at)
      VALUES (?1, ?2, 'System', 'disabled', ?2)`).run(SYSTEM_APP_ID, now);
  });
  ctx.appStore = createAppStore(ctx);
  // Convenience hook used by the admin API after key/app mutations.
  ctx.invalidateAudienceCache = appId => ctx.appStore.invalidateAudienceCache(appId);
  ctx.provisionAppKeywords = appId => ctx.provisionKeywords?.(appId);
  ctx.config = {
    setupState: () => setupState(ctx),
    importLegacyApps: value => importLegacyApps(ctx, value),
    publishSetupCode(setup) {
      if (!setup.required) return setup;
      if (setup.created) {
        console.warn(JSON.stringify({ event: 'moderation.setup_code', code: setup.code,
          expiresAt: setup.expiresAt, hint: 'POST /admin/api/setup with this code' }));
      } else {
        console.warn(JSON.stringify({ event: 'moderation.setup_pending', expiresAt: setup.expiresAt }));
      }
      return setup;
    },
    ensureSetup: () => ensureSetupCode(ctx)
  };
  return ctx.config;
}

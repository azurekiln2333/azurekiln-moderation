import { createHash, randomUUID } from 'node:crypto';
import { ensureSetupCode, setupState } from '../admin-auth.js';
import { parseLegacyApps } from '../auth.js';
import { createAppStore, SYSTEM_APP_ID } from './store.js';

const digest = value => createHash('sha256').update(value).digest('hex');

/**
 * Imports MODERATION_APPS_JSON once. Existing applications are skipped, never overwritten:
 * the operator may already have rotated keys through the admin UI.
 * The legacy plaintext keys are stored as hashes so existing consumers keep working.
 */
export function importLegacyApps(ctx, value, { log = console } = {}) {
  let apps;
  try {
    apps = parseLegacyApps(value);
  } catch {
    log.error(JSON.stringify({ event: 'moderation.apps_import_failed' }));
    return { created: [], skipped: [], failed: true };
  }
  if (apps.length === 0) return { created: [], skipped: [], failed: false };
  const created = [];
  const skipped = [];
  for (const app of apps) {
    if (ctx.appStore.getApp(app.appId)) {
      skipped.push(app.appId);
      continue;
    }
    ctx.appStore.createApp({ appId: app.appId, name: app.appId });
    const now = ctx.now();
    ctx.transaction(() => {
      ctx.db.prepare(`INSERT INTO app_keys (key_id, app_id, kind, token_hash, status, created_at)
        VALUES (?,?,'api',?,'active',?)`).run(randomUUID(), app.appId, digest(app.apiKey), now);
      ctx.db.prepare(`INSERT INTO app_keys (key_id, app_id, kind, token_hash, status, created_at)
        VALUES (?,?,'admin',?,'active',?)`).run(randomUUID(), app.appId, digest(app.adminKey), now);
    });
    ctx.appStore.invalidateAudienceCache(app.appId);
    created.push(app.appId);
  }
  if (created.length) log.info(JSON.stringify({ event: 'moderation.apps_imported', created, skipped }));
  else if (skipped.length) log.info(JSON.stringify({ event: 'moderation.apps_import_skipped', skipped }));
  log.warn(JSON.stringify({ event: 'moderation.config_env_deprecated',
    hint: 'MODERATION_APPS_JSON has been imported into the database and can be removed' }));
  return { created, skipped, failed: false };
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

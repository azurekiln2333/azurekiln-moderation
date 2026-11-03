import { randomUUID } from 'node:crypto';
import { setupCodeHash, SETUP_CODE_TTL_MS } from './crypto.js';

/**
 * One-time setup codes (contract §4).
 *
 * Core generates the code at startup and writes only its digest into
 * `setup_tokens` (a valid row lives at most 24 hours). This module reads that
 * table so `POST /admin/api/setup` can redeem a code, and it can also mint one
 * when core injects no provider (tests, and `reset-admin.mjs --bootstrap`).
 */
export function initializeSetupCodes(ctx) {
  const nowMs = () => new Date(ctx.now()).getTime();

  const pending = ctx.db.prepare('SELECT * FROM setup_tokens WHERE consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1');
  const byHash = ctx.db.prepare('SELECT * FROM setup_tokens WHERE code_hash = ?');
  const consumeOne = ctx.db.prepare('UPDATE setup_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL');
  const consumeAll = ctx.db.prepare('UPDATE setup_tokens SET consumed_at = ? WHERE consumed_at IS NULL');

  return {
    /** `{required, available, expiresAt}` for the setup page probe. */
    state({ required }) {
      const row = required ? pending.get(ctx.now()) : null;
      return { required, available: Boolean(row), expiresAt: row?.expires_at ?? null };
    },
    /** Validates and consumes a code. Returns true only for the first redemption. */
    consume(code) {
      const hash = setupCodeHash(code);
      if (!hash) return false;
      const row = byHash.get(hash);
      if (!row || row.consumed_at) return false;
      if (new Date(row.expires_at).getTime() <= nowMs()) return false;
      const changes = Number(consumeOne.run(ctx.now(), row.id).changes);
      if (changes === 1) consumeAll.run(ctx.now());
      return changes === 1;
    },
    /** Invalidates every unused code, used once a super admin exists. */
    invalidateAll() {
      return Number(consumeAll.run(ctx.now()).changes);
    },
    /** Test/bootstrap helper: writes a digest and returns the plaintext once. */
    issue({ code, ttlMs = SETUP_CODE_TTL_MS }) {
      const hash = setupCodeHash(code);
      if (!hash) throw new Error('Setup code format is invalid');
      const at = ctx.now();
      const expiresAt = new Date(nowMs() + ttlMs).toISOString();
      ctx.db.prepare(`INSERT INTO setup_tokens (id, code_hash, created_at, expires_at, consumed_at)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(code_hash) DO UPDATE SET created_at = excluded.created_at,
          expires_at = excluded.expires_at, consumed_at = NULL`)
        .run(randomUUID(), hash, at, expiresAt);
      return { code, expiresAt };
    }
  };
}

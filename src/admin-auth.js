import { randomInt, randomUUID } from 'node:crypto';
import { generateSetupCode, hashPassword, SETUP_CODE_TTL_MS, setupCodeHash } from './crypto.js';

const RESET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function activeSuperAdmins(ctx) {
  return ctx.db.prepare("SELECT * FROM admin_users WHERE role='super' AND status='active'").all();
}

export function adminCount(ctx) {
  return Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n);
}

export function setupState(ctx) {
  const required = activeSuperAdmins(ctx).length === 0;
  if (!required) return { required: false, available: false, expiresAt: null };
  const row = ctx.db.prepare(`SELECT * FROM setup_tokens WHERE consumed_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1`).get(ctx.now());
  return { required: true, available: Boolean(row), expiresAt: row?.expires_at ?? null };
}

/**
 * Generates a one-time bootstrap code when no active super administrator exists.
 * The plaintext is returned exactly once (for the container log); only its hash is stored.
 */
export function ensureSetupCode(ctx) {
  const state = setupState(ctx);
  if (!state.required) return { required: false, created: false, code: null, expiresAt: null };
  if (state.available) return { required: true, created: false, code: null, expiresAt: state.expiresAt };
  const code = generateSetupCode();
  const now = ctx.now();
  const expiresAt = new Date(new Date(now).getTime() + SETUP_CODE_TTL_MS).toISOString();
  ctx.transaction(() => {
    ctx.db.prepare('DELETE FROM setup_tokens WHERE consumed_at IS NOT NULL OR expires_at <= ?').run(now);
    ctx.db.prepare('INSERT INTO setup_tokens (id, code_hash, created_at, expires_at) VALUES (?,?,?,?)')
      .run(randomUUID(), setupCodeHash(code), now, expiresAt);
  });
  return { required: true, created: true, code, expiresAt };
}

/**
 * Returns the usable setup token row for a presented code, or null.
 * Consumption is recorded by `createSuperAdmin` so validation and creation share a transaction.
 */
export function pendingSetupToken(ctx, code) {
  const hash = setupCodeHash(code);
  if (!hash) return null;
  const row = ctx.db.prepare('SELECT * FROM setup_tokens WHERE code_hash=?').get(hash);
  if (!row || row.consumed_at || row.expires_at <= ctx.now()) return null;
  return row;
}

export function createAdminUser(ctx, { username, password, displayName = null, role = 'admin',
  createdBy = null, mustChangePassword = false } = {}) {
  const id = randomUUID();
  const now = ctx.now();
  ctx.db.prepare(`INSERT INTO admin_users (admin_id, username, username_lower, display_name, password_hash, role,
    status, must_change_password, failed_attempts, password_updated_at, created_at, updated_at, created_by)
    VALUES (?,?,?,?,?,?,'active',?,0,?,?,?,?)`).run(id, username, username.toLowerCase(), displayName,
    hashPassword(password), role, Number(mustChangePassword), now, now, now, createdBy);
  return ctx.db.prepare('SELECT * FROM admin_users WHERE admin_id=?').get(id);
}

export function generateResetPassword(length = 24) {
  let out = '';
  for (let index = 0; index < length; index += 1) out += RESET_ALPHABET[randomInt(RESET_ALPHABET.length)];
  return out;
}

/** Resets a password, invalidates every session of that account, and forces a change at next login. */
export function resetAdminPassword(ctx, { username, newPassword }) {
  const row = username
    ? ctx.db.prepare('SELECT * FROM admin_users WHERE username_lower=?').get(String(username).toLowerCase())
    : ctx.db.prepare("SELECT * FROM admin_users WHERE role='super' AND status='active' ORDER BY created_at LIMIT 1").get();
  if (!row) return null;
  const now = ctx.now();
  ctx.transaction(() => {
    ctx.db.prepare(`UPDATE admin_users SET password_hash=?, must_change_password=1, failed_attempts=0,
      locked_until=NULL, password_updated_at=?, updated_at=? WHERE admin_id=?`)
      .run(hashPassword(newPassword), now, now, row.admin_id);
    ctx.db.prepare('UPDATE admin_sessions SET revoked_at=? WHERE admin_id=? AND revoked_at IS NULL')
      .run(now, row.admin_id);
  });
  return { adminId: row.admin_id, username: row.username, role: row.role };
}

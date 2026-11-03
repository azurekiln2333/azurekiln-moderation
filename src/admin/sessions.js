import { randomUUID } from 'node:crypto';
import { generateToken, sha256Hex } from './crypto.js';

export { CSRF_HEADER } from './csrf.js';
export const SESSION_COOKIE = 'moderation_admin';
export const DEFAULT_SESSION_TTL_MS = 43_200_000;
export const DEFAULT_SESSION_IDLE_MS = 1_800_000;
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Admin browser sessions (contract §3).
 *
 * The cookie carries a 32-byte base64url token; the database stores only its
 * SHA-256 digest. `csrf_token` is per session, returned only by the session
 * endpoints, and compared in constant time. Idle and absolute lifetimes are
 * enforced on read; `last_seen_at` is written at most once per minute.
 */
export function initializeSessions(ctx, options = {}) {
  const ttlMs = options.ttlMs ?? Number(process.env.MODERATION_SESSION_TTL_MS ?? DEFAULT_SESSION_TTL_MS);
  const idleMs = options.idleMs ?? Number(process.env.MODERATION_SESSION_IDLE_MS ?? DEFAULT_SESSION_IDLE_MS);
  const insecure = options.insecureCookie ?? process.env.MODERATION_ADMIN_INSECURE_COOKIE === '1';
  const nowMs = () => new Date(ctx.now()).getTime();

  const insert = ctx.db.prepare(`INSERT INTO admin_sessions
    (session_id, token_hash, admin_id, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
  const byHash = ctx.db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ?');
  const byId = ctx.db.prepare('SELECT * FROM admin_sessions WHERE session_id = ?');
  const touch = ctx.db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE session_id = ?');
  const revoke = ctx.db.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL');
  const revokeOthers = ctx.db.prepare(`UPDATE admin_sessions SET revoked_at = ?
    WHERE admin_id = ? AND session_id <> ? AND revoked_at IS NULL`);
  const revokeAdmin = ctx.db.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE admin_id = ? AND revoked_at IS NULL');

  function cookieOptions(expires) {
    return { httpOnly: true, sameSite: 'lax', path: '/', secure: !insecure, expires };
  }

  function issue({ adminId, ip = null, userAgent = null }) {
    const token = generateToken(32);
    const csrfToken = generateToken(32);
    const sessionId = randomUUID();
    const now = ctx.now();
    const expiresAt = new Date(nowMs() + ttlMs).toISOString();
    const agent = typeof userAgent === 'string' ? userAgent.slice(0, 256) : null;
    insert.run(sessionId, sha256Hex(token), adminId, csrfToken, ip, agent, now, now, expiresAt);
    return { sessionId, token, csrfToken, expiresAt };
  }

  function applyCookie(res, token, expiresAt) {
    res.cookie(SESSION_COOKIE, token, cookieOptions(new Date(expiresAt)));
  }

  function clearCookie(res) {
    res.cookie(SESSION_COOKIE, '', cookieOptions(new Date(0)));
  }

  /** Resolves a request cookie to its live session row, enforcing both lifetimes. */
  function resolve(req) {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (typeof raw !== 'string' || raw.length < 16 || raw.length > 512) return null;
    const row = byHash.get(sha256Hex(raw));
    if (!row || row.revoked_at) return null;
    const now = nowMs();
    const expires = new Date(row.expires_at).getTime();
    const idleDeadline = new Date(row.last_seen_at).getTime() + idleMs;
    if (now >= expires || now >= idleDeadline) {
      revoke.run(new Date(now).toISOString(), row.session_id);
      return null;
    }
    if (now - new Date(row.last_seen_at).getTime() >= TOUCH_INTERVAL_MS) {
      touch.run(ctx.now(), row.session_id);
    }
    return row;
  }

  return {
    ttlMs,
    idleMs,
    issue,
    applyCookie,
    clearCookie,
    resolve,
    findById: sessionId => byId.get(sessionId) ?? null,
    revoke(sessionId, at = ctx.now()) {
      return Number(revoke.run(at, sessionId).changes);
    },
    revokeOthers(adminId, keepSessionId) {
      return Number(revokeOthers.run(ctx.now(), adminId, keepSessionId).changes);
    },
    revokeAdmin(adminId) {
      return Number(revokeAdmin.run(ctx.now(), adminId).changes);
    },
    cleanup(cutoff) {
      return Number(ctx.db.prepare('DELETE FROM admin_sessions WHERE revoked_at IS NOT NULL AND expires_at < ?')
        .run(cutoff).changes);
    }
  };
}

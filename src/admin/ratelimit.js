import { randomUUID } from 'node:crypto';

const WINDOW_MS = 15 * 60_000;
const USER_FAILURES = 5;
const IP_FAILURES = 20;
const MIN_RETRY_AFTER_S = 60;

/**
 * Login throttling (contract §3, §5.1).
 *
 * Two sliding-window buckets are kept per attempt: `user:<lower>@<ip>` and
 * `ip:<ip>`. Attempts are stored in SQLite so a restart cannot reset a budget.
 * `retryAfterMs` reports the wait until the oldest counted failure leaves the
 * window, floored at the contract's 60 second minimum.
 */
export function initializeLimiter(ctx, options = {}) {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const nowMs = () => new Date(ctx.now()).getTime();
  const insert = ctx.db.prepare('INSERT INTO admin_login_attempts (id, bucket, success, created_at) VALUES (?, ?, ?, ?)');
  const recent = ctx.db.prepare(`SELECT created_at FROM admin_login_attempts
    WHERE bucket = ? AND success = 0 AND created_at > ? ORDER BY created_at`);

  function failures(bucket, now) {
    return recent.all(bucket, new Date(now - windowMs).toISOString());
  }

  function bucketState(bucket, limit, now) {
    const rows = failures(bucket, now);
    if (rows.length < limit) return null;
    // Wait until enough of the oldest failures age out to drop below the limit.
    const oldest = rows[rows.length - limit];
    return Math.max(MIN_RETRY_AFTER_S * 1000, new Date(oldest.created_at).getTime() + windowMs - now);
  }

  return {
    windowMs,
    userBucket: (usernameLower, ip) => `user:${usernameLower}@${ip}`,
    ipBucket: ip => `ip:${ip}`,
    /** Returns `{retryAfterMs}` when blocked, otherwise `null`. */
    check({ username, ip }) {
      const now = nowMs();
      const user = bucketState(`user:${String(username).toLowerCase()}@${ip}`, USER_FAILURES, now);
      const address = bucketState(`ip:${ip}`, IP_FAILURES, now);
      const retryAfterMs = Math.max(user ?? 0, address ?? 0);
      return retryAfterMs > 0 ? { retryAfterMs } : null;
    },
    record({ username, ip, success }) {
      const at = ctx.now();
      insert.run(randomUUID(), `user:${String(username).toLowerCase()}@${ip}`, Number(success), at);
      insert.run(randomUUID(), `ip:${ip}`, Number(success), at);
    },
    /** Successful logins clear that account's failure budget; the IP budget ages out. */
    clearUser({ username, ip }) {
      ctx.db.prepare('DELETE FROM admin_login_attempts WHERE bucket = ? AND success = 0')
        .run(`user:${String(username).toLowerCase()}@${ip}`);
    },
    cleanup(cutoff) {
      return Number(ctx.db.prepare('DELETE FROM admin_login_attempts WHERE created_at < ?').run(cutoff).changes);
    }
  };
}

export { USER_FAILURES, IP_FAILURES, MIN_RETRY_AFTER_S };

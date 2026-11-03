import { constantTimeEqual } from './crypto.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const CSRF_HEADER = 'x-csrf-token';

export function isWrite(method) {
  return WRITE_METHODS.has(method);
}

/** Request origin derived from `Origin`, else from `Referer`, else null. */
export function requestOrigin(req) {
  const origin = req.get('origin');
  if (typeof origin === 'string' && origin.length > 0) return origin;
  const referer = req.get('referer');
  if (typeof referer === 'string' && referer.length > 0) {
    try {
      return new URL(referer).origin;
    } catch {
      return 'invalid';
    }
  }
  return null;
}

/**
 * Same-origin enforcement (contract §3).
 *
 * `Origin`/`Referer`, when present, must match the request host (honoring
 * `MODERATION_PUBLIC_ORIGIN` for reverse-proxied deployments), and
 * `Sec-Fetch-Site` must not be `cross-site`. Deployments that also terminate TLS
 * in front of the service rely on this, so the check runs on every write and on
 * login, setup and logout.
 */
export function createOriginGuard(options = {}) {
  const publicOrigin = options.publicOrigin ?? process.env.MODERATION_PUBLIC_ORIGIN ?? null;
  return function assertSameOrigin(req) {
    const site = req.get('sec-fetch-site');
    if (site && site.toLowerCase() === 'cross-site') return false;
    const origin = requestOrigin(req);
    if (origin === null) return true;
    const allowed = new Set();
    const host = req.get('host');
    if (host) {
      allowed.add(`http://${host}`);
      allowed.add(`https://${host}`);
      const bare = host.replace(/:\d+$/, '');
      allowed.add(`http://${bare}`);
      allowed.add(`https://${bare}`);
    }
    if (publicOrigin) {
      try {
        allowed.add(new URL(publicOrigin).origin);
      } catch { /* a malformed override simply adds nothing */ }
    }
    return allowed.has(origin);
  };
}

/**
 * Double-submit CSRF check: the header must be present and equal to the
 * session's stored token. Origin is asserted separately for every write.
 */
export function verifyCsrf(req, session) {
  const presented = req.get(CSRF_HEADER);
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 512) return false;
  if (!session || typeof session.csrf_token !== 'string') return false;
  return constantTimeEqual(presented, session.csrf_token);
}

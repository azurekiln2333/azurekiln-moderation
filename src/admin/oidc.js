import { createHash } from 'node:crypto';
import { generateToken } from './crypto.js';

const STATE_TTL_MS = 600_000;
const DISCOVERY_TTL_MS = 3_600_000;

/**
 * Optional OIDC login (contract §5.5).
 *
 * Only standard discovery plus the authorization-code flow with PKCE is used;
 * nothing here knows about a specific gateway. The configuration lives in
 * `oidc_settings`; with no row, or `enabled = 0`, the console exposes no login
 * entry point and `GET /admin/api/auth/oidc/start` is a 404.
 */
export function initializeOidc(ctx, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const nowMs = () => new Date(ctx.now()).getTime();
  const cache = new Map();

  const readSettings = ctx.db.prepare("SELECT * FROM oidc_settings WHERE id = 'default'");
  const upsertSettings = ctx.db.prepare(`INSERT INTO oidc_settings
    (id, enabled, issuer, client_id, client_secret, allowed_emails, scopes, created_at, updated_at)
    VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, issuer = excluded.issuer,
      client_id = excluded.client_id, client_secret = excluded.client_secret,
      allowed_emails = excluded.allowed_emails, scopes = excluded.scopes, updated_at = excluded.updated_at`);
  const deleteSettings = ctx.db.prepare("DELETE FROM oidc_settings WHERE id = 'default'");

  const putState = ctx.db.prepare(`INSERT INTO oidc_states
    (state_hash, code_verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const takeState = ctx.db.prepare('DELETE FROM oidc_states WHERE state_hash = ? RETURNING *');

  function parseAllowlist(value) {
    return String(value ?? '')
      .split(/[\s,]+/)
      .map(entry => entry.trim().normalize('NFKC').toLowerCase())
      .filter(Boolean);
  }

  function settings() {
    const row = readSettings.get();
    if (!row) return null;
    return {
      enabled: row.enabled === 1,
      issuer: row.issuer,
      clientId: row.client_id,
      clientSecret: row.client_secret,
      allowedEmails: parseAllowlist(row.allowed_emails),
      scopes: row.scopes,
      updatedAt: row.updated_at
    };
  }

  /** The active configuration, or null when OIDC must not be offered at all. */
  function active() {
    const current = settings();
    if (!current || !current.enabled || !current.issuer || !current.clientId || current.allowedEmails.length === 0) {
      return null;
    }
    return current;
  }

  function publicSettings() {
    const current = settings();
    if (!current) return { enabled: false, configurable: false };
    return {
      enabled: current.enabled,
      configurable: true,
      issuer: current.issuer,
      clientId: current.clientId,
      clientSecretSet: typeof current.clientSecret === 'string' && current.clientSecret.length > 0,
      allowedEmails: current.allowedEmails,
      scopes: current.scopes,
      updatedAt: current.updatedAt
    };
  }

  function httpsUrl(value, name) {
    let url;
    try {
      url = new URL(String(value));
    } catch {
      throw ctx.httpError(400, 'invalid_request', `${name} must be an absolute URL`);
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw ctx.httpError(400, 'invalid_request', `${name} must be an HTTPS URL without credentials`);
    }
    return url;
  }

  /**
   * Redirect URIs must be absolute and credential-free. HTTPS is required except
   * for loopback hosts, which is how a local http console is reached.
   */
  function redirectUrl(value) {
    let url;
    try {
      url = new URL(String(value));
    } catch {
      throw ctx.httpError(400, 'invalid_request', 'redirectUri must be an absolute URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw ctx.httpError(400, 'invalid_request', 'redirectUri must be an HTTP(S) URL without credentials');
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
    if (url.protocol === 'http:' && !loopback) {
      throw ctx.httpError(400, 'invalid_request', 'redirectUri must use HTTPS unless it points at loopback');
    }
    return url;
  }

  async function discovery(issuer) {
    const cached = cache.get(issuer);
    if (cached && cached.expiresAt > nowMs()) return cached.document;
    const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    let response;
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error' });
    } catch {
      throw ctx.httpError(400, 'invalid_request', 'OIDC discovery failed');
    }
    if (!response.ok) throw ctx.httpError(400, 'invalid_request', 'OIDC discovery failed');
    let document;
    try {
      document = await response.json();
    } catch {
      throw ctx.httpError(400, 'invalid_request', 'OIDC discovery failed');
    }
    if (!document || typeof document.issuer !== 'string' ||
        typeof document.authorization_endpoint !== 'string' || typeof document.token_endpoint !== 'string') {
      throw ctx.httpError(400, 'invalid_request', 'OIDC discovery failed');
    }
    for (const endpoint of [document.authorization_endpoint, document.token_endpoint]) {
      try {
        httpsUrl(endpoint, 'endpoint');
      } catch {
        throw ctx.httpError(400, 'invalid_request', 'OIDC discovery failed');
      }
    }
    cache.set(issuer, { document, expiresAt: nowMs() + DISCOVERY_TTL_MS });
    return document;
  }

  function digest(value) {
    return createHash('sha256').update(value).digest('hex');
  }

  function challengeFor(verifier) {
    return createHash('sha256').update(verifier).digest('base64url');
  }

  function matchesAllowlist(email, allowed) {
    const normalized = String(email ?? '').normalize('NFKC').toLowerCase();
    if (!normalized) return false;
    return allowed.some(entry => (entry.startsWith('@') ? normalized.endsWith(entry) : normalized === entry));
  }

  return {
    enabled: () => active() !== null,
    settings,
    publicSettings,
    async save({ enabled, issuer, clientId, clientSecret, allowedEmails, scopes, redirectUri }) {
      const existing = settings();
      const nextIssuer = issuer === undefined ? existing?.issuer : (issuer === null || issuer === '' ? null : httpsUrl(issuer, 'issuer').href.replace(/\/$/, ''));
      const nextClientId = clientId === undefined ? existing?.clientId : clientId;
      // An omitted secret preserves the stored one; null or '' clears it.
      const nextSecret = clientSecret === undefined ? (existing?.clientSecret ?? '') : (clientSecret ?? '');
      const nextScopes = scopes === undefined ? (existing?.scopes ?? 'openid email profile') : scopes;
      const nextAllowed = allowedEmails === undefined
        ? (existing?.allowedEmails ?? [])
        : parseAllowlist(Array.isArray(allowedEmails) ? allowedEmails.join(' ') : allowedEmails);
      const nextEnabled = enabled === undefined ? (existing?.enabled ?? false) : enabled;

      if (typeof nextClientId !== 'string' || !nextClientId) {
        throw ctx.httpError(400, 'invalid_request', 'clientId is required');
      }
      if (typeof nextSecret !== 'string') throw ctx.httpError(400, 'invalid_request', 'clientSecret must be a string');
      if (typeof nextScopes !== 'string') throw ctx.httpError(400, 'invalid_request', 'scopes must be a string');
      if (typeof nextEnabled !== 'boolean') throw ctx.httpError(400, 'invalid_request', 'enabled must be a boolean');
      if (nextEnabled) {
        if (!nextIssuer) throw ctx.httpError(400, 'invalid_request', 'issuer is required to enable OIDC');
        if (nextAllowed.length === 0) {
          throw ctx.httpError(400, 'invalid_request', 'at least one allowed email or @domain is required to enable OIDC');
        }
        if (redirectUri !== undefined) redirectUrl(redirectUri);
        await discovery(nextIssuer);
      }
      const at = ctx.now();
      upsertSettings.run(Number(nextEnabled), nextIssuer ?? '', nextClientId, nextSecret,
        nextAllowed.join(' '), nextScopes, existing ? (readSettings.get()?.created_at ?? at) : at, at);
      cache.clear();
      return publicSettings();
    },
    clear() {
      deleteSettings.run();
      cache.clear();
    },
    /** Builds the authorization redirect and remembers state/PKCE/nonce server-side. */
    async beginAuthorization({ redirectUri = null, returnTo = null } = {}) {
      const current = active();
      if (!current) throw ctx.httpError(404, 'not_found', 'not_configured');
      const document = await discovery(current.issuer);
      const state = generateToken(24);
      const nonce = generateToken(24);
      const verifier = generateToken(48);
      const createdAt = ctx.now();
      putState.run(digest(state), verifier, nonce, returnTo, createdAt,
        new Date(nowMs() + STATE_TTL_MS).toISOString());
      const url = new URL(document.authorization_endpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', current.clientId);
      if (redirectUri) url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', current.scopes);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', challengeFor(verifier));
      url.searchParams.set('code_challenge_method', 'S256');
      return { authorizationUrl: url.href, state };
    },
    /** One-time state consumption; returns `{codeVerifier, nonce, returnTo}`. */
    consumeState(state) {
      if (typeof state !== 'string' || state.length === 0 || state.length > 128) return null;
      const row = takeState.get(digest(state));
      if (!row) return null;
      if (new Date(row.expires_at).getTime() <= nowMs()) return null;
      return { codeVerifier: row.code_verifier, nonce: row.nonce, returnTo: row.return_to };
    },
    /** Exchanges the code and validates the ID token claims against the settings. */
    async completeLogin({ code, codeVerifier, nonce, redirectUri = null }) {
      const current = active();
      if (!current) throw ctx.httpError(404, 'not_found', 'not_configured');
      const document = await discovery(current.issuer);
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: codeVerifier });
      if (redirectUri) form.set('redirect_uri', redirectUri);
      const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
      if (current.clientSecret) {
        headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(current.clientId)}:${encodeURIComponent(current.clientSecret)}`).toString('base64')}`;
      }
      let response;
      try {
        response = await fetchImpl(document.token_endpoint, { method: 'POST', headers, body: form, redirect: 'error' });
      } catch {
        throw ctx.httpError(502, 'upstream_error', 'OIDC token exchange failed');
      }
      if (!response.ok) throw ctx.httpError(401, 'unauthorized', 'OIDC token exchange rejected');
      let tokens;
      try {
        tokens = await response.json();
      } catch {
        throw ctx.httpError(401, 'unauthorized', 'OIDC token exchange rejected');
      }
      const claims = decodeJwtPayload(tokens?.id_token);
      if (!claims) throw ctx.httpError(401, 'unauthorized', 'OIDC ID token is malformed');
      if (claims.iss !== document.issuer && claims.iss !== current.issuer) {
        throw ctx.httpError(401, 'unauthorized', 'OIDC issuer mismatch');
      }
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audience.includes(current.clientId)) throw ctx.httpError(401, 'unauthorized', 'OIDC audience mismatch');
      if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs()) {
        throw ctx.httpError(401, 'unauthorized', 'OIDC ID token expired');
      }
      if (nonce !== null && nonce !== undefined && claims.nonce !== nonce) {
        throw ctx.httpError(401, 'unauthorized', 'OIDC nonce mismatch');
      }
      const email = String(claims.email ?? '').normalize('NFKC').toLowerCase();
      if (!matchesAllowlist(email, current.allowedEmails)) {
        throw ctx.httpError(403, 'forbidden', 'OIDC account is not allowed');
      }
      return { email, claims };
    },
    cleanup(cutoff) {
      return Number(ctx.db.prepare('DELETE FROM oidc_states WHERE expires_at < ?').run(cutoff).changes);
    }
  };
}

export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

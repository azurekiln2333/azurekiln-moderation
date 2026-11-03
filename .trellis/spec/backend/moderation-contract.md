# Executable moderation contract

## 1. Scope / trigger

This contract applies to the independent moderation service, its database, and the SDK integration. The root README is the external API source of truth. Do not copy moderation rules into consumer applications.

## 2. Signatures

- `createApp(options) -> Promise<ExpressApplication>`; `app.locals.close()` closes maintenance and SQLite.
- `initialize(ctx)` and `registerRoutes(v1Router,ctx)` are synchronous extension exports.
- `ctx.transaction(fn)` accepts synchronous work only. Nested work joins the outer transaction.
- `ctx.migrate(namespace,[{version,sql}])` applies checksummed, ordered, transactional migrations.
- `ctx.review.requiresReview(appId,scene) -> boolean` and `ctx.review.enqueue(input) -> reviewId` connect text/image moderation to the queue.
- Every app-scoped database read/update/delete includes `app_id=?` and bound values.

## 3. Contracts

- Authenticate `X-App-Id` plus `Authorization: Bearer <key>`. `req.auth` owns tenant identity. Request bodies and forwarding headers cannot override it.
- Keep API and admin keys separate and unique. `/admin/*` requires the selected app's admin role.
- Normalize words and text with the same NFKC/OpenCC/lowercase/separator-removal function before matching. Keyword mutations invalidate the local cache; other processes refresh within 60 seconds.
- The core migration owns applications, keywords, ip_rules, and audit_events. Extensions own namespaced migrations under their module paths. Canonicalize SQL line endings before hashing to keep Windows and Linux checksums compatible.
- Wrap each mutation and its audit event in one transaction. Text queue insertion and its decision audit are atomic. Do not return a successful check before its audit write completes.
- Keep audits for 365 days. Delete only `created_at < cutoff`; equality survives. Ext retention uses the latest action anchor. Credentials and scene policies are not cleanup targets.
- Required configuration: none. Optional: `HOST`, `PORT`, `MODERATION_DB_PATH`, and the database-backed admin settings.
  `MODERATION_APPS_JSON` is a one-time upgrade import only; never require it at startup and never fail boot on it.
  Do not add a shorter retention override.
- Region rules use an injected local resolver. Unknown resolution returns 503 when an enabled region rule needs evaluation. Never add an undisclosed external service or disable TLS verification.

### Admin console (`/admin`, `/admin/api`)

- The service owns the console; `src/app.js` mounts the admin API at `/admin/api` and the static bundle at `/admin`. Mount the bundle through `src/admin-ui/index.js` (one implementation, one set of hardening headers). `/admin/setup` and `/admin/login` redirect to the matching hash routes.
- Sessions: the cookie carries a 32-byte token; the database stores only its SHA-256 hash. `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` unless `MODERATION_ADMIN_INSECURE_COOKIE=1` for local http. Enforce both an idle and an absolute lifetime on every read; touch `last_seen_at` at most once a minute.
- CSRF: every write needs `X-CSRF-Token` equal (constant time) to the session's stored token, and same-origin `Origin`/`Referer`; reject `Sec-Fetch-Site: cross-site`. Login, setup, and logout assert origin but need no token.
- Passwords use scrypt with stored parameters (`scrypt$N$r$p$salt$hash`), never a new dependency. Setup codes and session tokens are only ever stored as hashes; plaintext is printed once to the log or shown once in a response.
- Tenant routes live at `/admin/api/apps/:appId/...` and reuse the `/v1/admin/*` semantics. Reject unknown, reserved (`_system`), and malformed ids with 404 before the shared handlers run, so a tenant route never serves an empty collection for a stranger.
- Roles: `super` manages accounts and OIDC settings, `admin` manages business data, `viewer` is read-only. OIDC is discovery plus the authorization-code flow with PKCE, state, and nonce; with no enabled row it exposes no login entry point and `/auth/oidc/start` returns 404.
- ID-token claims are verified (`iss`, `aud`, `exp`, `nonce`, allowlist) from the token endpoint response over TLS. Do not accept tokens from any other source, and keep `redirect: 'error'` on the exchange.

## 4. Validation & error matrix

| Condition | Required outcome |
| --- | --- |
| Missing or invalid tenant credentials | 401 unauthorized |
| API key on an admin route | 403 forbidden |
| Another app's resource ID | 404 not_found |
| Invalid field, explicit null for a required PATCH field, malformed JSON/IP/path | 400 invalid_request |
| Duplicate normalized app/category keyword or canonical IP rule | 409 conflict |
| Oversized JSON / unsupported encoding | 413 payload_too_large / 415 unsupported_media_type |
| Unknown region for an enabled region rule | 503 moderation_unavailable |
| Admin request without a session | 401 unauthorized |
| Admin write without a matching CSRF token, or cross-site | 403 csrf_failed |
| Role not permitted for the route | 403 forbidden |
| Repeated login failures past the window budget | 429 rate_limited with Retry-After |
| Consumed or expired setup code | 410 setup_code_invalid |
| Setup after a super administrator exists | 409 already_initialized |
| Unknown, reserved, or malformed tenant id on `/apps/:appId/**` | 404 not_found |
| Audit write failure | Roll back mutation/queue; never return pass |
| SDK network/timeout/5xx/invalid check response | Throw moderation.unavailable, or review+unavailable when failClosed=false |

All HTTP errors use `{error,message,requestId}`. Do not expose SQLite messages, secrets, or matched words. Check hits return IDs and categories.

## 5. Good / base / bad cases

- Good: `買 賣 槍 支` matches an enabled `买卖枪支` keyword in the same app.
- Base: clean text passes when the scene policy is off, and queues when it is on.
- Bad: an app-B admin presents an app-A keyword ID; return 404 and preserve the row.
- Bad: a region rule exists but no resolver is configured; return 503, never pass.
- Good: with an empty database the first boot prints one setup code, the operator creates the super administrator, and the code is dead afterwards.
- Bad: an upgraded application whose keys lived only in `MODERATION_APPS_JSON` is left with no key, so every request returns 401 while the log says the variable can be removed. Adopt the legacy keys when an existing application has none.

## 6. Required tests

- Core HTTP tests assert tenant isolation, role enforcement, JSON/error envelopes, variant matching, all category codes, CRUD visibility, and raw-text redaction.
- Database tests assert migration repeatability/checksums/rollback, durable restart, cross-process refresh at 60 seconds, one-time app seeding, and the exact 365-day cutoff.
- Ext tests assert scene policies, image fallback, review/report finality, app-scoped reads, retention anchors, and rollback when audit writes fail.
- SDK tests assert timeout coverage through response-body reading, fail-closed errors, redirect rejection, ESM/CommonJS exports, and offline tarball installation.
- Admin tests assert setup one-time use and expiry, login throttling, session idle/absolute expiry, CSRF and origin rejection, the role matrix, unknown-tenant 404s, OIDC hidden-until-configured, and that keys minted in the console drive the unchanged `/v1` API including rotation and disabling.
- The console tests run the real HTTP stack (`test/core/admin-console.test.js`) so a divergence between the bundle and the admin API fails the suite.
- On Windows, close every live and restarted SQLite connection before deleting a test file. Keep the reopened instances in the cleanup resource list. Do not assume after-hooks run in reverse registration order.

## 7. Wrong vs correct

Wrong: `SELECT * FROM keywords WHERE id=?`; this can cross tenant boundaries.

Correct: `SELECT * FROM keywords WHERE app_id=? AND id=?`, binding `req.auth.appId` first.

Wrong: update a policy, send 200, then write the audit asynchronously.

Correct: update and audit inside `ctx.transaction`, then send the response after commit.

Wrong: interpret an unavailable SDK response as pass.

Correct: withhold publication unless both IP and content decisions are exactly `pass`.

Wrong: keep an audit-list handler that never constrains `app_id`, or trust `req.params.appId` without checking the tenant exists.

Correct: require a live session, reject unknown/reserved ids with 404, and pass `req.auth.appId` derived from the verified route parameter.

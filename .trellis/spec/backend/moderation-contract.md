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
- Required configuration: `MODERATION_APPS_JSON`. Optional: `HOST`, `PORT`, `MODERATION_DB_PATH`. Do not add a shorter retention override.
- Region rules use an injected local resolver. Unknown resolution returns 503 when an enabled region rule needs evaluation. Never add an undisclosed external service or disable TLS verification.

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
| Audit write failure | Roll back mutation/queue; never return pass |
| SDK network/timeout/5xx/invalid check response | Throw moderation.unavailable, or review+unavailable when failClosed=false |

All HTTP errors use `{error,message,requestId}`. Do not expose SQLite messages, secrets, or matched words. Check hits return IDs and categories.

## 5. Good / base / bad cases

- Good: `買 賣 槍 支` matches an enabled `买卖枪支` keyword in the same app.
- Base: clean text passes when the scene policy is off, and queues when it is on.
- Bad: an app-B admin presents an app-A keyword ID; return 404 and preserve the row.
- Bad: a region rule exists but no resolver is configured; return 503, never pass.

## 6. Required tests

- Core HTTP tests assert tenant isolation, role enforcement, JSON/error envelopes, variant matching, all category codes, CRUD visibility, and raw-text redaction.
- Database tests assert migration repeatability/checksums/rollback, durable restart, cross-process refresh at 60 seconds, one-time app seeding, and the exact 365-day cutoff.
- Ext tests assert scene policies, image fallback, review/report finality, app-scoped reads, retention anchors, and rollback when audit writes fail.
- SDK tests assert timeout coverage through response-body reading, fail-closed errors, redirect rejection, ESM/CommonJS exports, and offline tarball installation.
- On Windows, close every live and restarted SQLite connection before deleting a test file. Keep the reopened instances in the cleanup resource list. Do not assume after-hooks run in reverse registration order.

## 7. Wrong vs correct

Wrong: `SELECT * FROM keywords WHERE id=?`; this can cross tenant boundaries.

Correct: `SELECT * FROM keywords WHERE app_id=? AND id=?`, binding `req.auth.appId` first.

Wrong: update a policy, send 200, then write the audit asynchronously.

Correct: update and audit inside `ctx.transaction`, then send the response after commit.

Wrong: interpret an unavailable SDK response as pass.

Correct: withhold publication unless both IP and content decisions are exactly `pass`.

# Azurekiln Moderation

Independent, app-isolated content moderation service. This README is the v1 API contract for QFLI and the Azurekiln gateway. Runtime: Node.js >=24.15, ESM, Express, local SQLite. Default listener: `127.0.0.1:4310`. No public SaaS is required.

## Ownership

| Owner | Exclusive paths |
| --- | --- |
| W1-core | README.md, package.json, package-lock.json, .gitignore, .trellis/spec/**, src/app.js, src/server.js, src/auth.js, src/db.js, src/errors.js, src/validation.js, src/audit.js, src/text/**, src/ip/**, migrations/**, data/**, scripts/**, test/core/** |
| W1-ext | src/image/**, src/review/**, src/reports/**, packages/client/**, deploy/**, test/ext/**, Dockerfile, docker-compose.yml, .dockerignore |

Only core edits shared root package files and this README. Ext records deployment details in `deploy/README.md` and requests shared changes from core. Modules own their schema migrations inside their exclusive paths. Do not edit or stage the other worker's files.

## Authentication and common types

Every `/v1/*` request sends:

```http
X-App-Id: qflistudio
Authorization: Bearer <apiKey>
Content-Type: application/json
```

Provision apps through `MODERATION_APPS_JSON`, an array of `{appId,apiKey,adminKey}`. Keys must be distinct, at least 32 characters, and provided through a secret file/environment. API keys authorize checks, review result queries, and report submission. An app's admin key additionally authorizes `/v1/admin/*`. Each admin key manages only its own app. No cross-app/global-admin endpoint exists. Request bodies never select an app. Forwarded headers do not select a tenant or supply the IP being checked.

IDs are opaque strings. Times are UTC ISO 8601. `scene` is a nonempty string of at most 64 characters. Optional `userId`, `targetType`, and `targetId` strings have at most 128 characters. Optional `metadata` is a JSON object. List APIs return `{items,total,limit,offset}`, with `limit=50` (1..100) and `offset=0` (0..1000000). Resource IDs from another app return 404. Delete returns `200 {deleted:true}`. All successful check responses return HTTP 200, including blocked results:

```json
{
  "id": "decision-uuid",
  "decision": "pass",
  "categories": [],
  "hits": [],
  "createdAt": "2026-11-02T00:00:00.000Z"
}
```

`decision` is `pass|block|review`. Hits contain `{keywordId,category}` for text or `{ruleId,type}` for IP rules. Responses never expose matched keyword text. A queued result also contains `reviewId`. Consumers must withhold publication for both `block` and `review`.

Stable category codes: `politics`, `pornography`, `gambling`, `drugs`, `weapons`, `controlled_items`, `fraud`, `terrorism`, `prohibited_goods`, `advertising`, `custom`.

## Text and image checks

`POST /v1/text/check`

```json
{"scene":"post","text":"Text to check","userId":"42","ip":"192.0.2.1","targetType":"post","targetId":"123","metadata":{}}
```

Only `scene` and `text` are required. `text` may be empty and has at most 20,000 Unicode code points. Total JSON request size is at most 256 KiB. The service applies NFKC, traditional-to-simplified conversion, lowercase, and removal of spaces, punctuation, symbols, combining marks, and format/zero-width characters to both input and dictionary entries. A matching enabled keyword blocks the result. Otherwise an enabled scene pre-review policy queues it and returns `review`; otherwise it passes. Checks do not implicitly invoke the IP endpoint; publishing consumers call both.

`POST /v1/image/check`

```json
{"scene":"avatar","imageUrl":"https://app.example.cn/avatar/123.png","userId":"42","targetType":"user","targetId":"42","metadata":{}}
```

`scene` and `imageUrl` are required. Only HTTPS URLs without embedded credentials are accepted. Core never downloads this URL. An optional in-process provider implements `async check({appId,scene,imageUrl,userId,metadata}) -> {decision,categories,hits}`. Providers must preserve TLS verification and use only disclosed domestic infrastructure. No configured provider, a provider failure, or a provider `review` result creates a manual review item. An enabled scene pre-review policy queues any otherwise passing image. Provider setup belongs in `src/image/` and deployment documentation.

## IP rules

`POST /v1/ip/check {scene,ip,userId?}` returns the common check result. `scene` and an IPv4/IPv6 literal `ip` are required. App-specific IP and CIDR rules block matching addresses. IPv4-mapped IPv6 addresses are checked against IPv4 rules too. Optional region rules use a locally configured `regionResolver(ip) -> regionCode|null`; no remote geolocation service is called. If region rules exist but resolution is unavailable, return 503 instead of passing. Rule hits have `type: ip|cidr|region`; blocked responses include category `ip_restricted`.

## Word management (app admin)

- `GET /v1/admin/keywords?limit=50&offset=0&category=custom` lists `{id,word,category,enabled,createdAt,updatedAt}`.
- `POST /v1/admin/keywords {word,category,enabled?}` creates a keyword (201). `word` has 1..128 code points and must normalize to nonempty. `enabled` defaults to true.
- `PATCH /v1/admin/keywords/:id {word?,category?,enabled?}` updates a keyword (200).
- `DELETE /v1/admin/keywords/:id` deletes a keyword.

Duplicate normalized words in the same app/category return 409. Mutations become visible immediately in the handling process and within 60 seconds in another process sharing the database, below the 10-minute requirement. New apps receive an attributed local seed dictionary on first provisioning. Source, license, and import command are recorded in `data/README.md`; administrators must tune it before production use.

- `GET /v1/admin/ip-rules` lists rules.
- `POST /v1/admin/ip-rules {type:"ip"|"cidr"|"region",value,reason?,enabled?}` creates a rule (201).
- `PATCH /v1/admin/ip-rules/:id {type?,value?,reason?,enabled?}` updates a rule.
- `DELETE /v1/admin/ip-rules/:id` deletes a rule.

`reason` has at most 500 characters. Region codes are uppercase strings such as `CN-44`. A country rule such as `CN` also matches its subdivisions, including `CN-44`. All rules are deny rules. The default is to allow an IP when no enabled rule matches.

## Pre-review policies and queue

- `GET /v1/admin/scenes` lists `{scene,preReview,updatedAt}`.
- `GET /v1/admin/scenes/:scene` returns the policy; unknown scenes default to `{scene,preReview:false,updatedAt:null}`.
- `PUT /v1/admin/scenes/:scene {preReview:true|false}` persists the policy. The default is false. Apps have independent policies.
- `GET /v1/admin/reviews?status=pending&scene=post` lists review items. Optional status is `pending|approved|rejected`.
- `GET /v1/admin/reviews/:id` returns a full review item, including its payload.
- `POST /v1/admin/reviews/:id/resolve {decision:"pass"|"block",reason,actorId}` records the final decision. `reason` is required (1..1000 characters); `actorId` is required (1..128). Repeating the same decision is idempotent. A conflicting resolution returns 409.
- `GET /v1/reviews/:id` returns `{id,scene,kind,status,decision,reason,createdAt,resolvedAt,targetType,targetId}` without the submitted payload. Pending items have `decision:"review"` and `resolvedAt:null`.

Full items additionally contain `appId,userId,ip,payload,actorId`. `kind` is `text|image`. Status `approved` maps to decision `pass`, and `rejected` maps to `block`. A result query is the v1 delivery mechanism; no callback registration or outbound callback is enabled. Consumers poll the authenticated result endpoint and publish only after `pass`.

## Reports

- `POST /v1/reports {targetType,targetId,reporterId,reason}` creates `201 {id,status:"open",createdAt}`. All four fields are required. `reason` has 1..2000 characters. Reporter IDs have 1..128 characters.
- `GET /v1/admin/reports?status=open` lists reports. Optional status is `open|accepted|resolved|rejected`.
- `GET /v1/admin/reports/:id` returns the report and handling history.
- `POST /v1/admin/reports/:id/handle {status:"accepted"|"resolved"|"rejected",result,actorId}` records handling. `result` has 1..2000 characters. `actorId` is required. Terminal reports cannot return to open/accepted. Repeating the same terminal status, result, and actor is idempotent. Any conflicting terminal payload returns 409.

Reports and handling events are app scoped and retained for at least 365 days. Content deletion stays with the consuming application's administrator; this service records the report and outcome.

## Audit, retention, health, and errors

`GET /v1/admin/audit?action=text.check&limit=50&offset=0` lists `{id,appId,action,actorId,targetId,decision,data,createdAt}`. All check results, policy/rule mutations, queue resolutions, and report handling are committed before returning success. Audits store IDs/categories rather than raw submitted text or secrets. Review payloads are available only to app administrators. `GET /healthz` is unauthenticated and returns `200 {status:"ok"}` only after a database probe. It contains no tenant/configuration information.

Retention is fixed at 365 days, never shortened by an environment variable. Startup and hourly cleanup delete records strictly older than the cutoff. Resolve/handle operations refresh the retention anchor for reviews/reports, preserving 365 days after the latest action. Database backups must apply the same policy. Registration credentials/configuration are not deleted by cleanup.

Errors have `{error,message,requestId}`. A supplied `X-Request-Id` is accepted only as a short safe identifier; otherwise the service generates one. HTTP status/code pairs:

| Status | error | Meaning |
| --- | --- | --- |
| 400 | invalid_request | Malformed JSON, invalid fields, or invalid IP/CIDR |
| 401 | unauthorized | Missing/invalid app credentials |
| 403 | forbidden | API key used on an admin endpoint |
| 404 | not_found | Unknown route or app-scoped resource |
| 409 | conflict | Duplicate rule/keyword or conflicting final state |
| 413 | payload_too_large | JSON request exceeds the limit |
| 415 | unsupported_media_type | JSON body required |
| 503 | moderation_unavailable | Required dependency or region resolution unavailable |
| 500 | internal_error | Unexpected failure; no internal details returned |

A content block is a successful check with `decision:"block"`, not an HTTP error. SDK fail-closed failures use the exact user message `审核服务暂不可用` and must never be treated as pass.

## Node SDK contract (W1-ext)

`packages/client` is a standalone, dependency-free npm package named `@azurekiln/moderation-client`. It supports ESM named exports and CommonJS through `require`. W1-ext supplies both formats and tests the package tarball. Intended consumer API:

```js
import { ModerationClient, ModerationUnavailableError } from '@azurekiln/moderation-client';

const moderation = new ModerationClient({
  baseUrl: process.env.MODERATION_BASE_URL,
  appId: 'qflistudio',
  apiKey: process.env.MODERATION_API_KEY,
  timeoutMs: 3000,
  failClosed: true
});
const ip = await moderation.checkIp({ scene: 'post', ip: clientIp, userId });
const text = await moderation.checkText({ scene: 'post', text: content, userId });
// Publish only when ip.decision and text.decision both equal 'pass'.
const report = await moderation.submitReport({ targetType: 'post', targetId, reporterId: userId, reason });
const review = await moderation.getReview(reviewId);
```

Other method: `checkImage(body)`. The SDK uses AbortController timeouts and validates check-result decisions. HTTP 4xx errors preserve their status and code. With `failClosed:true` (default), network failures, timeouts, HTTP 5xx, and invalid check responses throw `ModerationUnavailableError` with `code:"moderation.unavailable"`, `status:503`, `message:"审核服务暂不可用"`. HTTP 5xx details remain in `upstreamStatus`, `upstreamCode`, and `cause`. `failClosed:false` returns a synthetic `decision:"review"` result with `unavailable:true`, never pass. Non-check methods always throw on failure. TLS verification remains enabled. Production uses HTTPS or an explicitly trusted private network.

Distribution: run `npm pack --workspace packages/client --pack-destination <temporary-output-dir>`. Copy the resulting `.tgz` into each consuming repository's `vendor/` directory; commit it there and reference `file:vendor/<tarball>.tgz` in that consumer's lockfile. Its Docker context must include `vendor/`. Do not depend on sibling repository paths or an unpublished registry package. Ext may additionally supply unpacked vendoring if an existing consumer convention requires it.

## Deployment contract

Run `npm ci`, then `npm run migrate`, then `npm start`. Tests use `npm test`, core tests use `npm run test:core`, syntax/lint uses `npm run lint`. Required environment: `MODERATION_APPS_JSON`; optional `HOST` (default `127.0.0.1`), `PORT` (default `4310`), `MODERATION_DB_PATH` (default `./var/moderation.sqlite`). Migrations run on startup too.

Production uses `docker-compose.yml` plus a `.env` beside it (template: `.env.example`), never a source build. `MODERATION_IMAGE` defaults to the CNB `latest` image. It binds `127.0.0.1:4310` and persists SQLite plus its WAL in a local named volume. Watchtower is pinned to `nickfedor/watchtower:1.23.2` and selects only the moderation container through its explicit name, enable label, and project scope. Watchtower excludes itself. Use a moving image tag for automatic updates, or pin a digest and stop the watcher for manual upgrades.

Local builds use **only** `docker-compose.build.yml`, a standalone configuration with its own default project/volume and no watcher. Run `docker compose -f docker-compose.build.yml --env-file <protected-env-file> up --build -d`. MySQL and Redis are not implemented or required. One service process owns each SQLite database; do not share it over NFS or SMB. Existing installations must preserve their current volume through `MODERATION_DATA_VOLUME`.

| Pipeline | Checks | Image publication |
| --- | --- | --- |
| `.github/workflows/build-and-push.yml` | Every push and PR; shared tests/lint plus Compose checks | Main and `v*` tags publish `ghcr.io/<owner>/<repository>` after checks |
| `.cnb.yml` (preserved) | Existing main/tag and PR validation | `docker.cnb.cool/<CNB-repository>/moderation` |

Both pipelines reuse `node scripts/publish-ci.mjs verify` for validation. GitHub publishes `sha-<full-commit>` and semantic-version tags such as `v1.0.0`. CNB publishes `sha-<short-commit>` and version tags. Main and stable releases advance `latest`; prereleases do not. PRs never log in or publish images. Override `MODERATION_IMAGE` to switch registry or pin a tag or digest. No workflow connects to production or needs deployment credentials.

Keep data and backups on domestic infrastructure. Terminate public TLS at the trusted host Nginx. Never publish admin/API secrets or disable certificate verification. See [deployment and operations](deploy/README.md) for configuration, private-registry access, backup, and update procedures.

## Internal extension contract (W1-core / W1-ext)

Core exports `async createApp(options={})` from `src/app.js`. Options include `dbPath`, `apps` (same shape as environment), `clock` (returns Date), `imageProvider`, and `regionResolver`. It returns an Express app with `app.locals.context` and `app.locals.close()` (stop maintenance and close SQLite).

Core loads `src/review/index.js`, `src/image/index.js`, and `src/reports/index.js`, in that order. Each exports synchronous `initialize(ctx)` and `registerRoutes(router,ctx)`. `router` is already mounted under `/v1` behind app authentication; register `/image/check`, not `/v1/image/check`. `req.auth` is `{appId,isAdmin}`. Admin routes call `ctx.requireAdmin`. Async route handlers may throw; Express propagates errors.

The context contains:

- `db`: Node `DatabaseSync`, foreign keys enabled, WAL and busy timeout configured.
- `now()`: current UTC ISO string.
- `transaction(fn)`: synchronous SQLite transaction; rollback on failure. Do not return a Promise.
- `migrate(namespace,[{version,sql}])`: apply ordered SQL migrations exactly once; namespaces `review`, `image`, `reports` belong to ext.
- `recordAudit({appId,action,actorId=null,targetId=null,decision=null,data={}})`: insert and return the audit ID; participate in an existing transaction.
- `httpError(status,error,message)`: construct an Error with safe HTTP fields.
- `stringField(value,name,{required=true,max=128,values}={})`: validate a string and return it, or return null for an omitted optional field. `values` is an optional allowed-values array.
- `assertObject(value,name="body")`: require a non-null, non-array JSON object and return it.
- `pagination(query)`: return validated `{limit,offset}`.
- `requireAdmin(req,res,next)`: enforce app admin role.
- `cleanupHandlers`: Map; ext registers `cleanupHandlers.set("review", cutoff => {...})`. The ISO cutoff is 365 days ago. Delete by the latest update/handling time; return deleted count.
- `imageProvider`, `regionResolver`: optional injected providers, never network calls from core.

Review `initialize` must set `ctx.review` with synchronous methods:

```js
ctx.review.requiresReview(appId, scene); // boolean
ctx.review.enqueue({ appId, kind, scene, payload, userId: null, ip: null,
  targetType: null, targetId: null }); // return review ID string
```

Core calls enqueue and audit inside one transaction for text checks. Ext initializes its own tables through `ctx.migrate` and always includes app_id in queries. Ext imports helpers only from the context (or its own modules), avoiding shared-file edits. All modules use one common error envelope and retention cutoff. Ext tests live under `test/ext/` and SDK tests under `packages/client/test/`.

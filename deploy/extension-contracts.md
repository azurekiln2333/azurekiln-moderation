# Extension maintenance contracts

## 1. Scope / trigger

Use this contract when modifying image checks, manual review, reports, SDK
transport, or deployment wiring. The root README remains the API authority.
Keep module helpers inside owned paths and use core context helpers at the
HTTP and database boundaries.

## 2. Signatures

Each extension exports synchronous `initialize(ctx)` and
`registerRoutes(router,ctx)`. Review sets:

```js
ctx.review.requiresReview(appId, scene); // boolean
ctx.review.enqueue({ appId, kind, scene, payload, userId: null, ip: null,
  targetType: null, targetId: null }); // opaque ID string
```

`ctx.migrate(namespace,[{version,sql}])` owns the `review`, `image`, and
`reports` namespaces. Never change SQL for an applied version. Add a version.
`ctx.transaction(fn)` accepts a synchronous callback. Provider awaits happen
before entering it. Policy reads happen inside the final write transaction.

## 3. Contracts

`review_policies` uses `(app_id,scene)` as its key. Every resource lookup and
mutation constrains `app_id`. `review_items.updated_at` and
`reports.updated_at` are retention anchors. `report_events` has an app-scoped
parent foreign key with `ON DELETE CASCADE`. Cleanup uses the core cutoff and
strict `<`, preserving the exact boundary. Policy configuration does not expire.

Core invokes review enqueue and audit in one text-check transaction. Image,
policy, resolution, report creation, and report handling write audit in their
own transaction. A failed audit must roll back the mutation.

The SDK deadline covers fetch and response decoding. Production config uses
`MODERATION_APPS_JSON` and persistent `MODERATION_DB_PATH`. Container `HOST`
is `0.0.0.0` while the published host port binds to `127.0.0.1`.

## 4. Validation and error matrix

| Condition | Required behavior |
| --- | --- |
| API key on an admin route | 403 `forbidden` |
| Resource belongs to another app | 404 `not_found` |
| Invalid fields, enum, or pagination | 400 `invalid_request` |
| Conflicting review decision | 409 `conflict` |
| Repeated same review decision | Same original result, no extra audit |
| Repeated terminal report with identical status/result/actor | Same original report and history |
| Changed terminal report payload | 409 `conflict` |
| No provider, provider failure, or invalid provider result | Durable manual review |
| SDK transport/decode/5xx check failure | Contracted unavailable error, or synthetic review when configured |
| SDK HTTP 4xx | Preserve status, code, request ID |

## 5. Good / base / bad cases

Good: an app enables `post` pre-review, queues clean text, resolves it, and polls
a sanitized public result. An image provider can block an image even when
pre-review is enabled. Report processing records ordered administrator events.

Base: unknown scenes default to pre-review disabled. No image provider means
manual review. Consumers keep all `review` results private.

Bad: a provider failure becomes `pass`, an app selects another tenant in its
body, an audit failure leaves a mutation committed, or a cleanup deletes at the
exact cutoff. Each case has a regression assertion in the extension tests.

## 6. Required tests

Run `npm test` and `npm run lint`. Extension integration tests assert app/admin
boundaries, queue payload privacy, policy effects, final-state idempotence,
ordered history, restart persistence, audit rollback, and retention anchors.
SDK tests assert deadlines across stalled bodies, redirect rejection, malformed
response handling, HTTP error preservation, and offline packed installation.
The tarball test loads ESM and CommonJS from a separate consumer directory.

## 7. Wrong versus correct

Wrong:

```js
if (!providerResult) return { decision: 'pass' };
```

Correct: enqueue an app-scoped review and record the decision in one synchronous
transaction. Return its `reviewId`. Keep provider errors and raw payloads out of
audit. For SDK transport failures, return a synthetic `review` only when
`failClosed:false`, and omit `reviewId` because no queue item was accepted.

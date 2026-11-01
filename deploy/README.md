# Deployment and operations

Run this independent service on disclosed domestic infrastructure. The service
does not require an external moderation SaaS. Keep SQLite on a local persistent
disk. Use one service process per database. Do not mount it over NFS or SMB.

## Container

Install Docker Engine and Compose v2 on the deployment host. From this repository:

```sh
docker compose --env-file /etc/azurekiln/moderation.env config --quiet
docker compose --env-file /etc/azurekiln/moderation.env up --build -d
docker compose --env-file /etc/azurekiln/moderation.env ps
```

An operator must create `/etc/azurekiln/moderation.env` outside the repository,
restrict it to the deployment account, and supply `MODERATION_APPS_JSON`.
Its value is a JSON array of `{appId,apiKey,adminKey}`. Generate distinct random
keys with at least 32 characters. Provision QFLI and gateway as separate apps
unless the consuming team explicitly intends them to share policies and data.
Do not print resolved Compose configuration or environment values into logs.

The image uses Node 24.15.0, an unprivileged user, and a database health probe.
The container listens on port 4310. Compose binds it to host loopback and stores
the database and WAL files in `moderation-data`. Root filesystem writes are
disabled. Startup applies all module migrations and runs retention cleanup.
Never run `docker compose down -v` against a production volume.

## Direct process

Install Node 24.15+ and supply `MODERATION_APPS_JSON` through the service manager.
Set `MODERATION_DB_PATH` to a persistent local path owned by the service account.

```sh
npm ci
npm run migrate
npm start
```

The default listener is `127.0.0.1:4310`. Run one managed process. Use the same
environment for migration and service startup. Allow the process to stop
gracefully before replacing it.

## TLS and smoke test

Adapt `deploy/nginx.conf.example` to the assigned hostname and valid certificate.
Validate the proxy configuration before reloading it. Keep the service port
private. API consumers must verify TLS certificates. Admin and API keys are
server-side credentials and must never ship in an app or website bundle.

Set `MODERATION_BASE_URL`, `MODERATION_APP_ID`, and `MODERATION_API_KEY` in the
operator environment, then run:

```sh
node deploy/smoke.mjs
```

The probe checks database health and an authenticated text check. It prints
only status and decision. A scene policy may make its decision `review`.
Check the Docker health status and application audit after deployment.

## Image provider

The shipped server has no configured image provider. Every valid image request
enters manual review. It stores an HTTPS reference and does not download it.
Review administrators inspect the referenced image using the consuming app's
trusted access controls. The consuming app polls `/v1/reviews/:id` and publishes
only after `decision:pass`.

A trusted in-process integration can call
`createApp({imageProvider:{async check(input) {...}}})`. The input contains
`appId,scene,imageUrl,userId,metadata`. Return `{decision,categories,hits}`.
Categories are strings; hits are objects with optional `keywordId`, `category`,
`ruleId`, and `type` string identifiers. Other hit fields are discarded. Missing,
failed, invalid, or `review` results enter the queue. An enabled pre-review
policy also queues passing results. A blocking result remains blocked.

Provider implementations must enforce their own network deadlines, preserve TLS
verification, and use only disclosed domestic infrastructure. Validate provider
URL access before fetching to prevent access to unintended private resources.
No provider endpoints, secrets, or third-party services are enabled by default.

## Administration and retention

Use the app's admin key for scene policies, pending reviews, report handling,
and audit queries documented in the root README. Admin keys manage one app.
API keys can submit reports and query sanitized review results. Review delivery
uses polling; no outbound callback is configured.

Maintainers should read `deploy/extension-contracts.md` before changing module
transactions, migrations, retention anchors, or SDK failure behavior.

SQLite stores decisions, pending payloads, reports, handling events, and audit
records. Cleanup runs at startup and hourly. It deletes rows strictly older
than 365 days. Review resolution and report handling reset the record's
retention anchor. Report history remains with the report until that anchor
expires. App credentials and scene policies are not retention targets.

Restrict database and backup access to the service operator. Use SQLite's online
backup API or `.backup` command; do not copy the main file without its live WAL.
Apply the same cutoff to backup copies and restored databases. Do not retain
unmaintained historical snapshots outside that policy. Confirm cleanup has run
before exposing a restored database. Keep all copies on domestic infrastructure.

## SDK distribution and upgrades

`packages/client/README.md` describes npm tarball vendoring. The consuming
repository commits its own `vendor/azurekiln-moderation-client-0.1.0.tgz`,
manifest, and lockfile. Its Docker build copies `vendor/` before `npm ci`.
This avoids sibling-checkout and unpublished-registry dependencies.

Before an upgrade, run `npm test` and `npm run lint`, back up the database with
the retention policy applied, then rebuild and run the smoke test. The initial
schema is additive. Preserve a compatible database backup before a future
schema change; do not assume older images understand newer schema versions.

## Deployment handoff

The repository supplies deployment artifacts. A production hostname, host
access, TLS certificate, app credentials, and consumer configuration must be
provided by the operator. No production credentials or deployment destination
are embedded in the repository.

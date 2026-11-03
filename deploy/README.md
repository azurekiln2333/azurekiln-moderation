# Deployment and operations

Run this independent service on disclosed domestic infrastructure. The service
does not require an external moderation SaaS. Keep SQLite on a local persistent
disk. Use one service process per database. Do not mount it over NFS or SMB.

## CI and published images

GitHub Actions (`.github/workflows/build-and-push.yml`) checks every push and PR.
It uses the existing `node scripts/publish-ci.mjs verify` sequence: install from
the lockfile, syntax/lint, all service/SDK tests, and CNB pipeline tests. GitHub
also requires the Compose CLI so configuration checks cannot silently skip.
Only main pushes and `v*` tag pushes can publish to GHCR, after checks pass.
PR checks have read-only repository permissions and no registry login.
The publishing job uses `GITHUB_TOKEN` with `packages:write`, not a stored PAT.
Action versions are pinned to their verified commit SHAs.

The existing `.cnb.yml` remains unchanged. It tests main/tag builds before
publishing to CNB; PR builds only validate. Keep both pipelines enabled when
mirroring the repository. Neither pipeline contacts a production server.

| Registry | Revision tag | Release tag | Moving tag |
| --- | --- | --- | --- |
| `ghcr.io/<owner>/<repository>` | `sha-<full-commit>` | `v1.0.0` | `latest` |
| `docker.cnb.cool/<CNB-repository>/moderation` | `sha-<short-commit>` | `v1.0.0` | `latest` |

Use semantic-version release tags, including `v1.0.0-rc.1` for prereleases.
Main and stable releases advance `latest`; prereleases do not. Registries build
independently, so record the digest of the selected registry's actual image.

## Production container

Install Docker Engine and Compose v2 on the deployment host. From this repository:

```sh
docker compose --env-file /etc/azurekiln/moderation.env --env-file /etc/azurekiln/moderation.image.env config --quiet
docker compose --env-file /etc/azurekiln/moderation.env --env-file /etc/azurekiln/moderation.image.env pull
docker compose --env-file /etc/azurekiln/moderation.env --env-file /etc/azurekiln/moderation.image.env run --rm --no-deps moderation node scripts/migrate.mjs
docker compose --env-file /etc/azurekiln/moderation.env --env-file /etc/azurekiln/moderation.image.env up -d --wait --wait-timeout 90 --no-build moderation
docker compose --env-file /etc/azurekiln/moderation.env --env-file /etc/azurekiln/moderation.image.env ps
```

An operator must create `/etc/azurekiln/moderation.env` outside the repository,
restrict it to the deployment account, and supply `MODERATION_APPS_JSON`.
Its value is a JSON array of `{appId,apiKey,adminKey}`. Generate distinct random
keys with at least 32 characters. Provision QFLI and gateway as separate apps
unless the consuming team explicitly intends them to share policies and data.
Do not print resolved Compose configuration or environment values into logs.

Create `/etc/azurekiln/moderation.image.env` with the selected published
`MODERATION_IMAGE`, such as `ghcr.io/<owner>/<repository>:latest`. Protect this
file too. Production Compose has no build directive. It never builds source.

| Variable | Default / purpose |
| --- | --- |
| `MODERATION_IMAGE` | Required published tag or digest; select GHCR or CNB |
| `COMPOSE_PROJECT_NAME` | `azurekiln-moderation`; also sets scope and container names |
| `MODERATION_PORT` | `4310`; binding remains `127.0.0.1` |
| `MODERATION_DATA_VOLUME` | `<project>-data`; preserve an existing volume when upgrading |
| `WATCHTOWER_POLL_INTERVAL` | `600` seconds |

The image uses Node 24.15.0, an unprivileged user, and a database health probe.
The container listens on port 4310. Compose binds it to host loopback and stores
the database and WAL files at `/app/var` in `moderation-data`. The default
production volume name is `azurekiln-moderation-data`. Root filesystem writes are
disabled. Startup applies all module migrations and runs retention cleanup.
Never run `docker compose down -v` against a production volume.

SQLite is the only supported database. MySQL and Redis are neither supported
nor required, so there are no host-network or bundled-database variants.
Inspect the old container's `/app/var` mount before replacing an installation.
Set `MODERATION_DATA_VOLUME` to that existing volume's actual name. Earlier
source-build Compose installations may use
`azurekiln-moderation_moderation-data`; do not silently switch to an empty volume.

## Automatic updates and private registries

The pinned `nickfedor/watchtower:1.23.2` selects exactly the named moderation
container, its enable label, and the matching project scope. Other applications
and other projects are excluded. The watcher itself has `enable=false`.
It polls every 600 seconds and removes replaced images, while retaining the
database volume. After health and authenticated smoke checks pass, enable it:

```sh
docker compose --env-file /etc/azurekiln/moderation.env --env-file /etc/azurekiln/moderation.image.env up -d --no-build watchtower
```

Use a moving tag such as `latest` to receive new images. A digest or revision tag
keeps a fixed version; use manual upgrades and leave Watchtower stopped in that
mode. Watchtower reuses the running container configuration. Credential, port,
scope, or volume changes require an explicit `docker compose up -d`.

For private GHCR/CNB images, log in on the host with a read-only registry
credential using `docker login --password-stdin`. Host login alone does not give
the watcher credentials. Create a protected directory
`/etc/azurekiln/moderation-registry` containing a minimal Docker `config.json`
with that registry's auth. Do not use a config that depends on an uninstalled
credential helper. Add this host-only `compose.override.yaml` next to the
production `compose.yaml`; default Compose commands load it automatically:

```yaml
services:
  watchtower:
    environment:
      DOCKER_CONFIG: /registry-auth
    volumes:
      - type: bind
        source: /etc/azurekiln/moderation-registry
        target: /registry-auth
        read_only: true
        bind:
          create_host_path: false
```

Protect the directory and file with operator-only permissions. Mounting the
directory lets a credential rotation replace `config.json` without a stale file
mount. Public images need no registry override. Keep registry credentials and
this host override out of Git.

Stop only this project's watcher before backup, migrations, or rollback:

```sh
docker compose --env-file /etc/azurekiln/moderation.env --env-file /etc/azurekiln/moderation.image.env stop watchtower
```

Preserve the selected image digest/revision and a restorable database backup.
If rollback relies on a local image ID, save that image before enabling cleanup.
Do not let an older image write a database with an incompatible schema. Resume
automatic updates only after the relevant backup and acceptance checks pass.

## Local source builds

Use the standalone file **alone**, with synthetic/local app credentials:

```sh
docker compose -f compose.build.yaml --env-file /path/to/local-moderation.env config --quiet
docker compose -f compose.build.yaml --env-file /path/to/local-moderation.env up --build -d
```

No `MODERATION_IMAGE` is required. This builds `azurekiln-moderation:local`, sets
the Watchtower enable label to false, and has no updater service. Do not merge
the production file into this command. Defaults are project
`azurekiln-moderation-local` and volume `azurekiln-moderation-local-data`.
Use a different `MODERATION_PORT` if production already uses host port 4310.

Configuration regression tests run through `npm test`. Set
`MODERATION_COMPOSE_BIN` to an official standalone Compose binary when the
`docker compose` plugin is unavailable. These tests use dummy credentials and
an empty temporary env file, never operator environment files. Without a CLI
they explicitly skip; GitHub requires the CLI before running them.

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

Before an upgrade, run `npm test` and `npm run lint`, pause Watchtower, and back
up the database with the retention policy applied. Pull the tested published
image, recreate the service, and run the smoke test. Use `compose.build.yaml`
only for local builds. The initial
schema is additive. Preserve a compatible database backup before a future
schema change; do not assume older images understand newer schema versions.

## Deployment handoff

The repository supplies deployment artifacts. A production hostname, host
access, TLS certificate, app credentials, and consumer configuration must be
provided by the operator. No production credentials or deployment destination
are embedded in the repository.

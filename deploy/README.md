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

Install Docker Engine and Compose v2 on the deployment host. Copy `docker-compose.yml`
to one directory (or use this repository) and start it. **No `.env` file and no
credentials are required**: apps, API/admin keys, and administrator accounts live
in the SQLite database and are managed in the `/admin` console.

```sh
docker compose config --quiet
docker compose pull
docker compose up -d --wait --wait-timeout 90 --no-build moderation
docker compose ps
docker compose logs moderation | grep moderation.setup_code
```

On the first start, with an empty database, the service prints a one-time setup
code to the container log:

```json
{"event":"moderation.setup_code","code":"<one-time code>","expiresAt":"2026-11-04T00:00:00.000Z","hint":"POST /admin/api/setup with this code"}
```

Open `http://127.0.0.1:4310/admin/setup` through an SSH tunnel (or the HTTPS
proxy described below), paste the code, and create the super administrator. The
code hashes to the database, is valid for 24 hours, and is destroyed as soon as
it is used. After the first administrator exists the setup page is closed and no
new code is generated on restart. The code is never written to the log again;
if it is also lost, use the reset procedure below.

`MODERATION_IMAGE` defaults to `docker.cnb.cool/azurekiln/azurekiln-moderation/moderation:latest`.
Set it in an optional `.env` or with `--env-file <path>` to use
`ghcr.io/azurekiln2333/azurekiln-moderation:latest` or to pin a digest.
Production Compose has no build directive. It never builds source.

| Variable | Default / purpose |
| --- | --- |
| `MODERATION_IMAGE` | `docker.cnb.cool/azurekiln/azurekiln-moderation/moderation:latest`; override with a GHCR tag or a digest |
| `COMPOSE_PROJECT_NAME` | `azurekiln-moderation`; also sets scope and container names |
| `MODERATION_PORT` | `4310`; binding remains `127.0.0.1` |
| `MODERATION_DATA_VOLUME` | `<project>-data`; preserve an existing volume when upgrading |
| `WATCHTOWER_POLL_INTERVAL` | `600` seconds |

The image copies `public/` as well as `src/`, so the `/admin` console ships with
the service and needs no separate web server or CDN.

`.env.example` lists only these optional overrides. Every setting ships
commented out, so `docker compose up -d` works on a bare host. Do not print
resolved Compose configuration or environment values into logs.

The image uses Node 24.15.0, an unprivileged user, and a database health probe.
The container listens on port 4310. Compose binds it to host loopback and stores
the database and WAL files at `/app/var` in `moderation-data`. The default
production volume name is `azurekiln-moderation-data`. Root filesystem writes are
disabled. Startup applies all module migrations and runs retention cleanup.
Never run `docker compose down -v` against a production volume.

`HOST`, `PORT`, and `MODERATION_DB_PATH` are fixed by Compose. Optional
database-settings environment variables, when a deployment needs to override a
default, come from the operator environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODERATION_KEY_GRACE_MS` | `3600000` | Key-rotation grace window (1 minute .. 7 days) |
| `MODERATION_SESSION_TTL_MS` | `43200000` | Absolute admin session lifetime |
| `MODERATION_SESSION_IDLE_MS` | `1800000` | Admin session idle timeout |
| `MODERATION_ADMIN_INSECURE_COOKIE` | `0` | Only `1` omits the `Secure` cookie flag; local http debugging only |
| `MODERATION_PUBLIC_ORIGIN` | unset | Optional public origin used for OIDC callback and Origin checks, e.g. `https://mod.example.cn` |

## Administration console

Every tenant setting moved from environment variables into the database and is
managed at `/admin`. The console covers:

- applications and their API/admin keys (issue, rotate, revoke, disable);
- keyword dictionaries per app, including batch import and export;
- IP/CIDR/region rules;
- pre-review (先审后发) switches per scene;
- the manual review queue;
- submitted reports and their handling;
- audit log queries;
- administrator accounts.

Key plaintext is shown **once**, at issue or rotation time. The database stores
only hashes. A rotated key keeps working for the grace window so consumers can be
redeployed without downtime; revoked keys and disabled apps are rejected
immediately by `/v1/*`.

The console is bound to `127.0.0.1` like the API. Reach it through an SSH tunnel:

```sh
ssh -L 4310:127.0.0.1:4310 <operator>@<deployment-host>
```

To serve it publicly, terminate TLS at the host Nginx with
`deploy/nginx.conf.example`, which proxies both `/v1/` and `/admin` to
`127.0.0.1:4310` and adds no-store and framing headers. Session cookies are
`HttpOnly; Secure; SameSite=Lax`, so the console must be reached over HTTPS at a
single hostname. Do not disable certificate verification or expose the container
port directly. Keep admin and API keys server-side; they must never ship in an
app or website bundle.

### Reset a forgotten administrator password

```sh
docker compose exec moderation node scripts/reset-admin.mjs
```

Without arguments the script resets the `super` account, prints a new random
password once, forces a password change on next login, and revokes that account's
sessions. Add `--username <name>` to reset a specific account. The script is
idempotent and exits non-zero when the database does not exist. Use
`--bootstrap` if every super administrator was deleted and a new setup code is
needed.

### Upgrading from environment-configured apps

Earlier releases required `MODERATION_APPS_JSON`. If that variable is still set,
startup imports its apps once (existing `appId` values are skipped), logs
`{"event":"moderation.apps_imported",...}`, and adds
`{"event":"moderation.config_env_deprecated"}`. Inspect the imported apps in
`/admin`, rotate their keys, and then delete the variable. An empty or missing
variable is silent; an invalid one never blocks startup because the database
already holds the configuration. The `/v1/*` paths, headers, and response shapes
are unchanged, so QFLI server and the gateway need no code changes.

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
docker compose up -d --no-build watchtower
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
credential helper. Add this host-only `docker-compose.override.yml` next to the
production `docker-compose.yml`; default Compose commands load it automatically:

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
docker compose stop watchtower
```

Preserve the selected image digest/revision and a restorable database backup.
If rollback relies on a local image ID, save that image before enabling cleanup.
Do not let an older image write a database with an incompatible schema. Resume
automatic updates only after the relevant backup and acceptance checks pass.

## Local source builds

Use the standalone file **alone**; it also needs no credentials:

```sh
docker compose -f docker-compose.build.yml config --quiet
docker compose -f docker-compose.build.yml up --build -d
```

No `MODERATION_IMAGE` is required. This builds `azurekiln-moderation:local`, sets
the Watchtower enable label to false, and has no updater service. Do not merge
the production file into this command. Defaults are project
`azurekiln-moderation-local` and volume `azurekiln-moderation-local-data`.
Use a different `MODERATION_PORT` if production already uses host port 4310.
Local authentication uses the same database-backed accounts, so the local build
prints the same one-time setup code on first start.

Configuration regression tests run through `npm test`. Set
`MODERATION_COMPOSE_BIN` to an official standalone Compose binary when the
`docker compose` plugin is unavailable. These tests use an empty temporary env
file and never read operator environment files. They also assert statically,
without any CLI, that neither file requires a secret or an `env_file`. Without a
CLI the runtime resolution cases explicitly skip; GitHub requires the CLI before
running them.

## Direct process

Install Node 24.15+ and set `MODERATION_DB_PATH` to a persistent local path owned
by the service account. No credentials are needed in the environment.

```sh
npm ci
npm run migrate
npm start
```

The default listener is `127.0.0.1:4310`. First start prints the one-time setup
code; use it at `/admin/setup`. Run one managed process. Use the same database
path for migration and service startup. Allow the process to stop gracefully
before replacing it.

## TLS and smoke test

Adapt `deploy/nginx.conf.example` to the assigned hostname and valid certificate.
It proxies both `/v1/` and `/admin` to `127.0.0.1:4310`, so the console and the
API live on one HTTPS origin. Validate the proxy configuration before reloading
it. Keep the service port private. API consumers must verify TLS certificates.
Admin and API keys are server-side credentials and must never ship in an app or
website bundle.

Create the consuming app in `/admin` first, copy its API key once, then set
`MODERATION_BASE_URL`, `MODERATION_APP_ID`, and `MODERATION_API_KEY` in the
operator environment and run:

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

Manage applications, keys, dictionaries, rules, pre-review scenes, the review
queue, reports, audits, and administrators in `/admin`. The console stores
sessions in the database and enforces CSRF and login rate limits. OIDC login is
optional and only appears when an issuer, client ID, client secret, and allowed
accounts are configured in the console; without that configuration no OIDC entry
is exposed.

The legacy `/v1/admin/*` endpoints keep working with an app's admin key, and
`/v1/reports` keeps working with an API key. App admin keys manage one app only;
API keys can submit reports and query sanitized review results. Review delivery
uses polling; no outbound callback is configured.

Maintainers should read `deploy/extension-contracts.md` before changing module
transactions, migrations, retention anchors, or SDK failure behavior.

SQLite stores decisions, pending payloads, reports, handling events, and audit
records. Cleanup runs at startup and hourly. It deletes rows strictly older
than 365 days. Review resolution and report handling reset the record's
retention anchor. Report history remains with the report until that anchor
expires. Applications, keys, administrator accounts, setup codes, and scene
policies are not retention targets; expired admin sessions and login attempts are
cleaned on the same 365-day cutoff.

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
image, recreate the service, and run the smoke test. Use `docker-compose.build.yml`
only for local builds. The initial
schema is additive. Preserve a compatible database backup before a future
schema change; do not assume older images understand newer schema versions.

## Deployment handoff

The repository supplies deployment artifacts. A production hostname, host
access, TLS certificate, administrator password, and consumer configuration must
be provided by the operator. No production credentials or deployment destination
are embedded in the repository.

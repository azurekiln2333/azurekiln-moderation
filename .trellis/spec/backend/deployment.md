# Deployment contract

## 1. Scope / trigger

Applies to `docker-compose.yml`, `docker-compose.build.yml`, GitHub/CNB image workflows,
and `deploy/README.md`. The root README defines the public deployment contract.
Keep the sibling QFLI moderation rollout instructions consistent with it.

## 2. Signatures

```sh
docker compose --env-file <credentials.env> --env-file <image.env> config --quiet
docker compose --env-file <credentials.env> --env-file <image.env> up -d --no-build moderation
docker compose -f docker-compose.build.yml --env-file <local.env> up --build -d
node scripts/publish-ci.mjs verify
```

Use `MODERATION_COMPOSE_BIN=<official-standalone-binary>` for configuration tests
when the Docker Compose plugin is unavailable. No daemon is needed for parsing.

## 3. Contracts

- Production requires `MODERATION_APPS_JSON`; `MODERATION_IMAGE` defaults to the CNB `latest` image. It pulls an
  existing image and has no build directive. Local mode requires only app keys.
- Fixed host binding is `127.0.0.1`. `MODERATION_PORT` changes only the port.
- `COMPOSE_PROJECT_NAME` controls container names and the Watchtower scope.
  Watchtower must also require the enable label and the exact moderation name.
  Pin `nickfedor/watchtower:1.23.2` and keep its own enable label false.
- SQLite and WAL persist at `/app/var`. `MODERATION_DATA_VOLUME` preserves an
  existing volume. Each project has distinct default storage. No MySQL/Redis
  driver or sidecar is implemented.
- Local configuration stands alone, has a false update label, and no watcher.
- GitHub checks all pushes/PRs. Image publication requires successful checks
  and a push to main or a `v*` tag. Only the image job has `packages:write`.
  All action references are full, verified commit SHAs.
- Keep `.cnb.yml` and its shared validation script. Each registry builds its own
  image. Main and stable releases advance `latest`, while prereleases do not.
- A moving tag enables updates. Digests/revision tags stay fixed. Stop the
  watcher during backup/migration/rollback and retain the rollback image.
- Private-registry credentials stay outside Git. The host-only override mounts
  a protected directory into Watchtower and sets `DOCKER_CONFIG` to that path.
  Host `docker login` alone does not authenticate the watcher.

## 4. Validation and error matrix

| Input / event | Required outcome |
| --- | --- |
| Missing production image | Compose config fails before startup |
| Missing app credentials in either mode | Compose config fails |
| Empty production image in standalone local mode | Local build config succeeds |
| Another project's name/scope | Not in this watcher's selected name/scope |
| PR or non-main branch push | Checks run, GHCR publish job does not run |
| Check job failure | Image job is blocked by `needs: check` |
| Prerelease version tag | Version/revision tags only, no `latest` advance |
| No Docker engine or registry publishing run | Report configuration checks only |

## 5. Good / base / bad cases

- Good: deploy a tested image using the old database volume's actual name.
- Base: a fresh project receives its own `<project>-data` volume and loopback
  listener. Local builds default to a separate `azurekiln-moderation-local` project.
- Bad: replacing an installation with a new default volume silently loses access
  to its existing moderation data. Inspect `/app/var` before an upgrade.

## 6. Required tests

Run `npm test`, `npm run lint`, `node --test scripts/publish-ci.test.mjs`, and
actionlint after workflow edits. GitHub must require `docker compose version`
before running shared validation so Compose tests cannot silently skip.

`test/ext/compose.test.js` parses real CLI JSON. Assert loopback binding, volume
reuse, project isolation, all three update selectors, self-exclusion, no local
updater, and rejection of missing settings. Use dummy keys and an empty temporary
env file. Validate documented registry overrides and rollback config changes
without connecting to production or reading operator credentials.

## 7. Wrong vs correct

Wrong: `docker compose -f docker-compose.yml -f docker-compose.build.yml up --build`.
The production watcher's service remains in the merge, and production required
variables interpolate before merging.

Correct: `docker compose -f docker-compose.build.yml --env-file <local.env> up --build -d`.
Use the standalone local file alone to keep automatic updates disabled.

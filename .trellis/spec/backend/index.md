# Moderation backend specifications

Read [moderation-contract.md](./moderation-contract.md) and the root README before changing a public API, tenant-scoped query, migration, retention handler, or module boundary.
Read [deployment.md](./deployment.md) before changing Compose, image publication,
deployment environment wiring, or update/rollback instructions.
Read [../../../docs/proposals/dynamic-config-contract.md](../../../docs/proposals/dynamic-config-contract.md)
before changing the database-backed configuration layer, the `/admin` API surface,
or the setup/reset flow.

## Zero-secret deployment

Applications, API/admin keys, and administrator accounts live in SQLite and are
managed at `/admin`. Deployment requires no `.env` and no `MODERATION_APPS_JSON`.
Only an empty database prints a one-time `moderation.setup_code` log line; recover
with `docker compose exec moderation node scripts/reset-admin.mjs`. The `/v1/*`
API, its headers, and its response shapes stay backward compatible.

## Pre-development checklist

1. Read the assigned task's PRD, design, and implementation plan.
2. Read the README ownership table. Edit only assigned paths.
3. Read the executable contract below and the module's current tests.
4. Trace the request through authentication, validation, transaction, audit, and response.

## Quality check

- Run `npm run lint` and the affected test script.
- Run `npm test` before an integration commit.
- Check app isolation, rollback on audit failure, and fail-closed behavior.
- Run `npm audit --omit=dev` after dependency/lockfile changes.
- Verify `git diff --check` and stage explicit owned paths only.
- Keep secrets, SQLite files, tarballs, and node_modules out of service commits.

# Moderation backend specifications

Read [moderation-contract.md](./moderation-contract.md) and the root README before changing a public API, tenant-scoped query, migration, retention handler, or module boundary.
Read [deployment.md](./deployment.md) before changing Compose, image publication,
deployment environment wiring, or update/rollback instructions.

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

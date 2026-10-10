---
title: DB Migration Operation-Class Gate
status: active
owner: builder
last_verified: 2026-10-10
summary: Every generated Drizzle migration in a PR MUST be classified EXPAND or CONTRACT, and that verdict MUST gate auto-merge unconditionally, independent of any workspace path configuration.
domain: releases
surfaces: [apps/web/src/lib/migration-safety.ts, apps/web/src/lib/migration-inspector.ts, apps/web/src/lib/auto-merge.ts, packages/core/db/schema.ts, packages/core/db/migration-index.ts]
related: [release-flow, scheduled-task-merge-policy]
keywords: [expand, contract, classifymigrationsql, schema drift, drizzle, escalatetopaths]
assertions:
  - id: classify-migration-sql
    type: symbol
    name: classifyMigrationSql
    path: apps/web/src/lib/migration-safety.ts
  - id: classify-pr-migrations
    type: symbol
    name: classifyPullRequestMigrations
    path: apps/web/src/lib/migration-safety.ts
  - id: inspect-pr-migrations
    type: symbol
    name: inspectPullRequestMigrations
    path: apps/web/src/lib/migration-inspector.ts
  - id: find-index-collisions
    type: symbol
    name: findIndexCollisions
    path: packages/core/db/migration-index.ts
  - id: renumber-against-base
    type: symbol
    name: renumberAgainstBase
    path: packages/core/db/migration-index.ts
  - id: evaluate-auto-merge-safety
    type: symbol
    name: evaluateAutoMergeSafety
    path: apps/web/src/lib/auto-merge.ts
---

## DB Migration Operation-Class Gate

**Capability statement**: The system MUST classify every generated Drizzle migration SQL file in a PR as `EXPAND` (additive, auto-mergeable) or `CONTRACT` (destructive, escalates to human), and MUST enforce this verdict unconditionally — independent of any workspace `escalateToPaths` or `denyPaths` configuration.

---

**Operation-class table**

| SQL Pattern | Class | Rationale |
|---|---|---|
| `CREATE TABLE` | EXPAND | New table; nothing existing breaks |
| `ADD COLUMN` (nullable or with `DEFAULT`) | EXPAND | Existing rows unaffected |
| `CREATE INDEX` (any form) | EXPAND | Index can be dropped without data loss |
| `ADD CONSTRAINT` | EXPAND | Additive; validation is CI's job |
| `DROP TABLE` | CONTRACT | Irreversible data loss |
| `DROP COLUMN` | CONTRACT | Irreversible; column data gone |
| `RENAME TABLE` | CONTRACT | Breaks all live readers |
| `RENAME COLUMN` | CONTRACT | Breaks all live readers |
| `ALTER COLUMN ... TYPE` | CONTRACT | Rewrites column data |
| `ALTER COLUMN ... SET NOT NULL` | CONTRACT | Locks table; fails on null rows |
| `ADD COLUMN ... NOT NULL` (no DEFAULT) | CONTRACT | Locks table; fails on existing rows |
| `INSERT/UPDATE/DELETE/MERGE` | CONTRACT (`kind: 'data'`) | Data migration — irreversible; see the data-migration policy below |
| Any other statement | CONTRACT | Fail-closed |

**Invariants**

- An EXPAND classification MUST only be emitted when every statement in the migration is in the EXPAND grammar above. Unrecognised statements MUST classify as CONTRACT (fail-closed).
- A CONTRACT classification MUST include a human-readable `trigger` string naming the statement and the table/column that triggered it.
- A PR containing both EXPAND and CONTRACT migrations MUST be rejected with a message instructing the author to split into two PRs: land the EXPAND migration first, once nothing reads the old column land the CONTRACT migration.
- The migration inspection MUST run for any PR that touches a generated migration file (`drizzle/NNNN_name.sql`) or `packages/core/db/schema.ts`, regardless of whether these paths appear in `escalateToPaths` or `denyPaths`.
- `packages/core/db/schema.ts` MUST NOT be treated as a standalone escalation path. It travels with its generated migration and is gated by the operation-class verdict on that migration.
- A `schema.ts` change without a corresponding generated migration MUST classify as CONTRACT (schema drift without migration).
- A CONTRACT verdict whose only CONTRACT statements move data (`INSERT/UPDATE/DELETE/MERGE`) MUST carry `kind: 'data'`. Any destructive statement in the same file or PR MUST win over it, whatever the order, so a backfill cannot hide a `DROP`.
- CI MUST fail a PR that adds a migration numbered at or below its base branch's newest (`bun run migrations:index-check`), naming the colliding file and the next free index. drizzle-kit takes the next index from the local journal, so parallel branches mint the same number; no claim-time reservation can change that without hand-editing journals, so the index is checked against the base and repaired by regeneration instead.
- The renumber MUST regenerate, not rename: `bun run migrations:renumber` resets the drizzle dir to the base's exact state and re-runs `drizzle-kit generate`. The migration-collision retry brief runs it (with `--min-index` past an open PR's slot that is not on the base yet).
- A data-only migration whose number collides with another open PR MUST report the collision first (a mechanical renumber); the data verdict applies again on the renumbered head.
- **Data-migration policy** (`mergePolicy.dataMigrations`): `'person'` (default) keeps a data migration a person's decision. `'agent-review'`, under tier `agent-review` only, lets the reviewer agent decide it: the reviewer pre-check, auto-merge and the escalation gate MUST NOT force a person for `kind: 'data'`, and the reviewer prompt asks the reviewer to judge the data change. A risk class the policy preset maps to `human` still applies. Destructive DDL, rewritten migrations, mixed PRs and uninspectable migrations are unaffected.

**Acceptance criteria**

- AC-1: GIVEN a PR that adds only `ADD COLUMN "summary" text` WHEN evaluated THEN `operationClass` is `EXPAND`, no human escalation fires, and the PR is eligible for auto-merge.
- AC-2: GIVEN a PR that includes `DROP COLUMN "legacy"` WHEN evaluated THEN `operationClass` is `CONTRACT`, the reason names the column (`drops column tableName.legacy`), and auto-merge is blocked.
- AC-3: GIVEN a PR with one EXPAND migration and one CONTRACT migration WHEN evaluated THEN the PR is rejected with a message containing `mixes EXPAND and CONTRACT` and includes the triggering statement.
- AC-4: GIVEN a migration file containing an unrecognised SQL statement (e.g. `DO $$ BEGIN ... END $$`) WHEN classified THEN `operationClass` is `CONTRACT`.
- AC-5: GIVEN a `schema.ts` change with no accompanying generated migration WHEN evaluated THEN `operationClass` is `CONTRACT` with reason `schema changed without a generated SQL migration`.
- AC-6: GIVEN a workspace whose path configuration (detected risk-class paths, or a legacy stored `escalateToPaths`) does NOT contain `drizzle/` WHEN a PR with an EXPAND migration is submitted THEN the inspector still runs, classifies it as EXPAND, and the PR passes auto-merge safety. (Removing `drizzle/` from path config does NOT disable the gate.)
- AC-7: GIVEN a PR that modifies or deletes an existing generated migration file WHEN evaluated THEN `operationClass` is `CONTRACT` (immutable migration history invariant).
- AC-8: GIVEN two open PRs whose migrations share the same sequence number WHEN either is evaluated THEN `operationClass` is `CONTRACT` (collision guard).
- AC-9: GIVEN an agent-review workspace with `mergePolicy.dataMigrations: 'agent-review'` WHEN a reviewer-approved PR's only CONTRACT statement is an `UPDATE` THEN the pre-check does not escalate and auto-merge safety passes; GIVEN the default WHEN the same PR is evaluated THEN auto-merge is refused with `runs data migration UPDATE on <table>`.

**Verification gate (EXPAND migrations)**

EXPAND migrations do not require human review, but CI MUST prove they are safe before auto-merge fires:

1. **Operation-class classifier** — `classifyMigrationSql` must return `{ safe: true, operationClass: 'EXPAND' }`. This is enforced in `evaluateAutoMergeSafety` before any merge attempt.
2. **Migrate test** — `bun db:migrate` against a test database MUST succeed. Verifies the migration applies cleanly. (Currently validated by Vercel preview deploy; a dedicated shadow-DB step is a planned enhancement.)
3. **Lock contention** — Future: wrap migrations in `SET lock_timeout = '3s'` and fail if ACCESS EXCLUSIVE is held longer than the threshold.

CONTRACT migrations always escalate to human review. The human confirms the timing (low-traffic window, PITR verified) before merging.

**PITR backstop**

Neon PITR is enabled. Recovery path for an EXPAND migration that causes data problems: restore to the snapshot taken immediately before the migration applied (typically within the 24-hour window). This is a backstop, not a design intention — EXPAND migrations should never need it.

**Code surface**

| Symbol | File |
|---|---|
| `classifyMigrationSql` | `apps/web/src/lib/migration-safety.ts` |
| `classifyPullRequestMigrations` | `apps/web/src/lib/migration-safety.ts` |
| `OperationClass` type | `apps/web/src/lib/migration-safety.ts` |
| `MigrationSafety` type | `apps/web/src/lib/migration-safety.ts` |
| `inspectPullRequestMigrations` | `apps/web/src/lib/migration-inspector.ts` |
| `evaluateAutoMergeSafety` | `apps/web/src/lib/auto-merge.ts` |
| `findIndexCollisions` / `renumberAgainstBase` | `packages/core/db/migration-index.ts` |

**Out of scope**

- Schema validation against live database (that is `db:migrate` / Drizzle Kit's job).
- Shadow-DB apply + rollback in CI (planned enhancement; requires dedicated Neon branch per PR).
- `squawk` / `eugene` linter integration (planned; classifier already covers the highest-risk patterns).
- Policy for which migration classes trigger a reviewer vs. merge gate — that is `mergePolicy` in `gitConfig`, not this classifier.

---
title: DB Migration Operation-Class Gate
status: active
owner: builder
last_verified: 2026-08-25
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
| `INSERT/UPDATE/DELETE/MERGE` | CONTRACT | Data migration — irreversible |
| Any other statement | CONTRACT | Fail-closed |

**Invariants**

- An EXPAND classification MUST only be emitted when every statement in the migration is in the EXPAND grammar above. Unrecognised statements MUST classify as CONTRACT (fail-closed).
- A CONTRACT classification MUST include a human-readable `trigger` string naming the statement and the table/column that triggered it.
- A PR containing both EXPAND and CONTRACT migrations MUST be rejected with a message instructing the author to split into two PRs: land the EXPAND migration first, once nothing reads the old column land the CONTRACT migration.
- The migration inspection MUST run for any PR that touches a generated migration file (`drizzle/NNNN_name.sql`) or `packages/core/db/schema.ts`, regardless of whether these paths appear in `escalateToPaths` or `denyPaths`.
- `packages/core/db/schema.ts` MUST NOT be treated as a standalone escalation path. It travels with its generated migration and is gated by the operation-class verdict on that migration.
- A `schema.ts` change without a corresponding generated migration MUST classify as CONTRACT (schema drift without migration).

**Acceptance criteria**

- AC-1: GIVEN a PR that adds only `ADD COLUMN "summary" text` WHEN evaluated THEN `operationClass` is `EXPAND`, no human escalation fires, and the PR is eligible for auto-merge.
- AC-2: GIVEN a PR that includes `DROP COLUMN "legacy"` WHEN evaluated THEN `operationClass` is `CONTRACT`, the reason names the column (`drops column tableName.legacy`), and auto-merge is blocked.
- AC-3: GIVEN a PR with one EXPAND migration and one CONTRACT migration WHEN evaluated THEN the PR is rejected with a message containing `mixes EXPAND and CONTRACT` and includes the triggering statement.
- AC-4: GIVEN a migration file containing an unrecognised SQL statement (e.g. `DO $$ BEGIN ... END $$`) WHEN classified THEN `operationClass` is `CONTRACT`.
- AC-5: GIVEN a `schema.ts` change with no accompanying generated migration WHEN evaluated THEN `operationClass` is `CONTRACT` with reason `schema changed without a generated SQL migration`.
- AC-6: GIVEN a workspace whose `escalateToPaths` does NOT contain `drizzle/` WHEN a PR with an EXPAND migration is submitted THEN the inspector still runs, classifies it as EXPAND, and the PR passes auto-merge safety. (Removing `drizzle/` from path config does NOT disable the gate.)
- AC-7: GIVEN a PR that modifies or deletes an existing generated migration file WHEN evaluated THEN `operationClass` is `CONTRACT` (immutable migration history invariant).
- AC-8: GIVEN two open PRs whose migrations share the same sequence number WHEN either is evaluated THEN `operationClass` is `CONTRACT` (collision guard).

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

**Out of scope**

- Schema validation against live database (that is `db:migrate` / Drizzle Kit's job).
- Shadow-DB apply + rollback in CI (planned enhancement; requires dedicated Neon branch per PR).
- `squawk` / `eugene` linter integration (planned; classifier already covers the highest-risk patterns).
- Policy for which migration classes trigger a reviewer vs. merge gate — that is `mergePolicy` in `gitConfig`, not this classifier.

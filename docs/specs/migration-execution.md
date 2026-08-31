---
title: DB Migration Execution
status: active
owner: max
last_verified: 2026-08-30
summary: Every committed migration MUST execute exactly once and only while its journal `when` exceeds the applied high-water mark; a missing tracking row below that mark MUST be backfilled, never replayed.
domain: releases
surfaces: [packages/core/db/migrate.ts, packages/core/db/migrate-plan.ts, packages/core/drizzle/meta/_journal.json, scripts/check-schema-drift.ts]
related: [db-migration-gates, release-flow]
verified_by: [packages/core/__tests__/migrate-plan.test.ts, packages/core/__tests__/migration-journal.test.ts, packages/core/__tests__/migration-journal-ordering.test.ts]
keywords: [__drizzle_migrations, planMigrations, high-water mark, _journal.json, last_migration_number, schema drift, 42703, backfill, toRun, toBackfill]
supersedes: []
---
# DB Migration Execution

**Capability statement**: When a migration actually runs — on deploy, on a
preview branch, or by hand — the runner MUST apply each committed migration's
DDL exactly once, MUST NOT replay DDL whose tracking row was merely lost, and
MUST fail the build rather than let new code serve traffic against a schema that
was not migrated.

This is the runtime half of the migration story. The PR-time half — classifying
a generated migration EXPAND vs CONTRACT and gating auto-merge on that verdict —
is `db-migration-gates`. Nothing here re-litigates whether a migration is
*allowed* to land; this spec governs what happens once it has.

Execution is **not** Drizzle's stock migrator. `packages/core/db/migrate.ts`
replaces it with `readMigrationFiles` + an explicit plan (`planMigrations`),
because the stock behaviour — "run everything whose `when` beats the last
recorded `created_at`" — is silently wrong in both directions, and both
directions reached production:

| Failure | What happened | Fix |
|---|---|---|
| Silent skip | `0067_tasks_path_manifest` carried `when` = 2025-07-11 against a DB already at 0065's 2026-07 mark. `db:migrate` exited 0, the deploy went green, and prod inserts threw `column "path_manifest" does not exist` (42703) for ~7h. Later read-only introspection found 0021 (`DROP TABLE secret_refs`) and 0022 had been skipped the same way, leaving prod *behind* instead of missing a column — reconciled by `0074_reconcile_missions_secret_refs_drift.sql`. | Journal-ordering tests; the newest entry must out-rank every prior `when`. |
| Blind replay | A custom runner (#1288) read "no tracking row" as "never applied" and replayed 0000's raw SQL, which recreates a unique index on `source_id` — a column 0002 had dropped for good. `db:migrate` crashed outright. | `planMigrations` backfills rather than re-executes anything at or below the high-water mark. |

## Invariants

### Plan

- The applied set is read **once per run** as every `created_at` in
  `drizzle.__drizzle_migrations` (not just the last row), and the high-water mark
  is `max(created_at)`, or `0` when the table is empty.
- A migration whose `folderMillis` is already in the applied set is neither run
  nor recorded again.
- A migration with no tracking row and `folderMillis` **strictly greater** than
  the high-water mark goes to `toRun` — its DDL executes.
- A migration with no tracking row and `folderMillis` **at or below** the
  high-water mark goes to `toBackfill` — it receives a tracking row and its DDL
  **MUST NOT** execute. Its DDL predates the newest migration known to have
  applied, so a later migration can already have moved the schema out from
  under it.
- `created_at` MUST compare numerically whether the driver returns it as a
  string or a number (`Number(r.created_at)`); a string/number mismatch would
  make every row look unapplied and put the entire history into `toRun`.

### Journal

- The newest journal entry MUST have a `when` greater than every prior entry.
  A trailing entry at or below the mark is not merely delayed — the backfill
  path writes it a tracking row, so it is marked applied forever and its DDL
  never runs, with `db:migrate` still exiting 0. Enforced on the **tail only**;
  four mid-list inversions (0020/21, 0032/33, 0043/44, 0116/17) are
  grandfathered, and "harmless" is confirmed only for 0116/17 (both landed in
  the same deploy, release v0.178.0) and disproven for 0020/21.
- Every journal entry MUST have its `.sql` file on disk. `readMigrationFiles`
  loops the whole journal and `readFileSync`s each tag *before* filtering by
  what is applied, so one missing file throws and **nothing** runs — a missing
  file is a total failure, not a partial one.
- Every `.sql` file in `packages/core/drizzle/` MUST be referenced by a journal
  entry, except the grandfathered inert stub `0024_numerous_firebird.sql`. An
  orphan is DDL that exists but is never applied — the same divergence, other
  half.
- `idx` and `tag` MUST be unique across entries.
- A migration file's identity is its content hash, not its name. Renaming a
  generated file to a reserved slot number (the flow
  `apps/web/src/lib/default-roles.ts` instructs agents to use) is therefore
  safe; editing an already-applied file's *content* is not, and is a CONTRACT
  violation under `db-migration-gates`.

### Execution

- Statements execute one at a time via `sql.raw` on the neon-http driver. There
  is **no** enclosing transaction: neon-http has no interactive transaction
  support, so a migration cannot be rolled back as a unit. A migration that
  fails partway leaves its earlier statements applied and no tracking row, and
  because its `when` still exceeds the mark it is **replayed from statement 1**
  on the next attempt.
- The tracking row for a migration is inserted immediately after that
  migration's statements, before the next migration starts, so a failure in
  migration N+1 never forces a re-run of N.
- `CREATE SCHEMA IF NOT EXISTS drizzle` and `CREATE TABLE IF NOT EXISTS
  drizzle.__drizzle_migrations` run before the plan, so a fresh database
  bootstraps without manual setup.
- Only these errors are transient and retried (24 attempts, 5s apart, with a
  fresh connection each time): `endpoint is disabled`,
  `connect ECONNREFUSED`, `ENOTFOUND`, `password authentication failed`. Every
  other failure exits 1 immediately.
- A failing run MUST surface the Postgres detail. neon-http hangs the real cause
  off nested properties, so `cause.message`, `detail`, `hint` and `position` are
  printed alongside `message` — a bare query with no cause is a regression.
- The process MUST exit explicitly on every path (0 on success, 1 on terminal
  failure). Production ordering comes from `apps/web/package.json`'s
  `"build": "bun run db:migrate && next build"`: a non-zero migrate exit means
  `next build` never runs, so no deploy can serve code against an un-migrated
  schema.

### Slot (serialising migration numbers across concurrent branches)

- `POST /api/workspaces/[id]/migration-slot` MUST allocate a number in a
  **single** `UPDATE ... SET last_migration_number = GREATEST(current,
  currentMax) + 1 ... RETURNING` — no SELECT-then-write. neon-http cannot run
  `db.transaction()` with interactive logic, so atomic UPDATE+RETURNING is the
  only serialisation primitive available.
- Two concurrent callers on the same workspace MUST receive distinct numbers.
- The returned `nextNumber` MUST be strictly greater than both the stored
  counter and any `currentMax` the caller reports, so a repo that advanced
  without using this API still gets a non-colliding number.
- `currentMax` is floored at 0 and truncated to an integer; a non-numeric value
  is ignored rather than rejected.
- `formatted` MUST be `nextNumber` zero-padded to 4 characters.
- An unknown workspace id MUST return 404 and change no counter; a missing or
  invalid API key MUST return 401 before any write.

### Drift gate (pre-promote, release PRs only)

- The gate compares production's `information_schema.columns` against the newest
  `packages/core/drizzle/meta/*_snapshot.json`. It is read-only.
- A column or table present in the **snapshot but absent from the DB** MUST
  pass, logged `[pending]`. Migrations run at deploy, which is *after* this
  check, so a pending forward migration is the normal state of a release PR and
  must not block it.
- A column or table present in the **DB but absent from the snapshot** MUST fail
  with `EXTRA in DB` / `EXTRA TABLE` and exit 1. Untracked manual DDL is the
  only fatal condition.
- The applied-migration count MUST be read from `drizzle.__drizzle_migrations`
  with a fallback to `public.__drizzle_migrations`. Querying only `public`
  throws and reports 0, which is indistinguishable from "no migration ever ran"
  against a long-lived production DB.
- The `Schema Drift / check-prod` job MUST always emit success or failure and
  never GitHub's `Skipped` status — branch protection treats `Skipped` as
  satisfied. The gate is therefore a *step*-level condition: the job always
  runs, exits 0 immediately when `base_ref != main`, and performs the real check
  only for dev→main.
- Any change under `packages/core/` other than a `package.json` makes
  `affected-tests.sh` emit `ALL`. A new migration is by definition such a change
  (`packages/core/drizzle/NNNN_*.sql` + `meta/_journal.json`), so the journal
  tests always run on a PR that adds one.

## Acceptance criteria

- AC-1: GIVEN tracking rows `[200]` and journal entries at `folderMillis`
  `[100, 200, 300]` WHEN `planMigrations` runs THEN `toRun` is `[300]` and
  `toBackfill` is `[100]` — the missing row for 100 is recorded, not replayed.
- AC-2: GIVEN a database with no tracking rows WHEN `planMigrations` runs THEN
  every journal entry is in `toRun` and `toBackfill` is empty.
- AC-3: GIVEN a tracking row whose `created_at` is the string `'100'` and a
  migration with `folderMillis` `100` WHEN `planMigrations` runs THEN both
  `toRun` and `toBackfill` are empty.
- AC-4 (failure path): GIVEN a new migration appended to `_journal.json` whose
  `when` is not greater than the max `when` of all prior entries WHEN the core
  journal tests run THEN they fail with a message naming the offending tag and
  the prior max — because in production that migration would be backfilled and
  its DDL would never run.
- AC-5 (failure path): GIVEN a journal entry whose `.sql` file is missing from
  `packages/core/drizzle/` WHEN `readMigrationFiles` is invoked THEN it throws
  and zero migrations are applied, including ones that would have succeeded.
- AC-6 (failure path): GIVEN a `.sql` file in `packages/core/drizzle/` that no
  journal entry references and that is not `0024_numerous_firebird.sql` WHEN the
  journal tests run THEN they fail listing that orphan.
- AC-7 (failure path): GIVEN a migration statement fails with an error not in
  the transient list WHEN `db:migrate` runs THEN it prints the message plus any
  `cause.message` / `detail` / `hint` / `position`, exits 1, and `next build`
  does not run.
- AC-8: GIVEN the first connection attempt fails with `endpoint is disabled`
  WHEN `db:migrate` runs THEN it logs `Attempt 1/24 failed`, sleeps 5s, and
  retries with a newly constructed connection.
- AC-9: GIVEN a workspace whose `last_migration_number` is 130 WHEN two
  `POST /api/workspaces/[id]/migration-slot` requests are issued concurrently
  THEN one returns `{ nextNumber: 131, formatted: "0131" }` and the other
  `{ nextNumber: 132, formatted: "0132" }` — never the same number.
- AC-10: GIVEN a stored counter of 130 and body `{ "currentMax": 140 }` WHEN the
  slot is reserved THEN the response is `{ nextNumber: 141, formatted: "0141" }`.
- AC-11 (failure path): GIVEN a valid API key and a workspace id that does not
  exist WHEN the slot route is called THEN it returns 404 `Workspace not found`;
  GIVEN no `Authorization` header THEN it returns 401 `Invalid API key` and
  performs no UPDATE.
- AC-12 (failure path): GIVEN production has column `tasks.hotfix_note` that the
  newest snapshot does not declare WHEN `scripts/check-schema-drift.ts` runs
  THEN it prints `EXTRA in DB    : tasks.hotfix_note  ← untracked manual DDL`
  and exits 1.
- AC-13: GIVEN the newest snapshot declares a column that production does not
  have yet WHEN `check-schema-drift.ts` runs THEN it logs
  `[pending] Column '<table>.<col>' not in DB yet` and exits 0.
- AC-14: GIVEN a pull request whose `base_ref` is `dev` WHEN the
  `Schema Drift / check-prod` job runs THEN it reports success without checking
  out the repo or connecting to any database, and its status is `success` —
  never `Skipped`.

## Code surface

| Symbol / artifact | Location |
|---|---|
| plan + apply loop, retry classification | `packages/core/db/migrate.ts:16-103` |
| tracking schema/table bootstrap | `packages/core/db/migrate.ts:31-38` |
| `readMigrationFiles` invocation | `packages/core/db/migrate.ts:44` |
| backfill loop (records, does not execute) | `packages/core/db/migrate.ts:56-62` |
| run loop + per-migration tracking insert | `packages/core/db/migrate.ts:64-76` |
| transient-error list / terminal exit | `packages/core/db/migrate.ts:88-100` |
| `planMigrations`, `MigrationPlan` | `packages/core/db/migrate-plan.ts:38-56` |
| high-water-mark computation | `packages/core/db/migrate-plan.ts:41` |
| journal (source of order) | `packages/core/drizzle/meta/_journal.json` |
| `workspaces.lastMigrationNumber` | `packages/core/db/schema.ts:630` |
| slot reservation (atomic UPDATE+RETURNING) | `apps/web/src/app/api/workspaces/[id]/migration-slot/route.ts:54-61` |
| slot auth / 404 / zero-pad | `apps/web/src/app/api/workspaces/[id]/migration-slot/route.ts:35-38,63-68` |
| agent-facing reserve-then-generate flow | `apps/web/src/lib/default-roles.ts:212-227` |
| drift gate: pending vs. fatal classification | `scripts/check-schema-drift.ts:131-167` |
| drift gate: tracking-count schema fallback | `scripts/check-schema-drift.ts:113-124` |
| `Schema Drift / check-prod` job (step-level gate) | `.github/workflows/build.yml:141-190` |
| "migrations are up to date" PR check | `.github/workflows/build.yml:66-78` |
| preview-branch migrate | `.github/workflows/build.yml:409-411` |
| deploy ordering (`db:migrate && next build`) | `apps/web/package.json:7` |
| `migrations:lint` | `package.json:42` |
| core-change → ALL tests fan-out | `scripts/affected-tests.sh:40-46` |
| tracking-table repair (one-off) | `packages/core/scripts/fix-migration-tracking.ts` |
| historical reconciliation migration | `packages/core/drizzle/0074_reconcile_missions_secret_refs_drift.sql` |

## Out of scope

- **EXPAND/CONTRACT classification and auto-merge gating** — owned entirely by
  `db-migration-gates` (`classifyMigrationSql`, `inspectPullRequestMigrations`,
  `evaluateAutoMergeSafety`). This spec assumes the migration already passed
  that gate and asks only what happens when it runs.
- **Workspace *tenancy* migration.** Despite the path, `POST
  /api/workspaces/[id]/migrate/precheck|execute|repair` and
  `apps/web/src/lib/workspace-migration.ts` move a *workspace between teams*
  (entity re-parenting under a `migration_log` ledger with a signed
  `dryRunToken`). They touch no DDL and are a different capability that still
  has no spec. Named here only so the name collision does not send a reader to
  the wrong document.
- `drizzle-kit generate` internals and snapshot production.
- `db:push` — forbidden in every environment; it bypasses tracking entirely.
- Shadow-DB apply/rollback per PR and `squawk`-class linting (see
  `db-migration-gates` → Out of scope).
- Neon PITR as a recovery backstop.
- The process rules around manual hotfix DDL and reconciliation-PR turnaround —
  that is doctrine, in `docs/design/migration-doctrine.md`, not a runtime
  contract.

## Verification gaps

Unguarded claims. Each is either asserted by no test or contradicted by the
code; do not read any of them as enforced.

1. **The slot route has no test at all.** There is no `route.test.ts` beside
   `migration-slot/route.ts`, so AC-9 through AC-11 are unverified — including
   the concurrency property the endpoint exists to provide.
2. **Slot acquisition does not assert caller scope.** The invariant is that a
   caller MUST hold access to the workspace whose slot it takes, and that a
   request failing that check MUST be rejected rather than served. No test
   asserts it. Specifics are tracked privately until the guard lands.
3. **The slot counter is per-workspace; the migration number space is
   per-repository.** Two workspaces pointing at the same repo can hand out the
   same number, which is exactly the collision the endpoint claims to prevent.
   Nothing keys the counter to the repo.
4. **Nothing requires migration SQL to be replay-safe.** Since a partial
   failure replays from statement 1, a non-idempotent statement makes the
   failure permanent — the 0000/`source_id` crash mode. The EXPAND grammar in
   `db-migration-gates` does not require `IF NOT EXISTS`.
5. **Concurrent `db:migrate` runs have no mutual exclusion.** The plan is read
   and then executed with no advisory lock (`pg_advisory_lock` appears nowhere
   in the repo), so two overlapping deploys can both put the same pending
   migration in `toRun` and execute it twice.
6. **The journal ordering check is tail-only and has a merge-race blind spot.**
   Two migrations authored on separate branches each pass individually; the
   inversion becomes invisible as soon as a third migration lands with a higher
   `when`. 0116/0117 is a live example that reached `main` unnoticed (0117's
   `when` is 7.1s below 0116's) and is absent from the grandfathered list in
   both test headers. It is harmless only because both shipped in one deploy —
   had 0116 deployed first, 0117 (`workers.pr_opened_base_sha`) would have been
   backfilled and never applied. No test asserts anything about the newest N
   entries.
7. **Backfill trusts an inference it never checks.** "No row and below the mark"
   is treated as "applied", with no introspection confirming the objects exist.
   On a restored or branched database where the DDL genuinely never ran, the
   backfill marks it applied permanently and silently. 0021/0022 is the
   historical instance.
8. **The drift gate only compares column *names*.** Type, nullability, default
   and index drift are invisible to it, as is any drift introduced after a
   release PR passes — it runs on dev→main PRs only, never on the deploy path.
9. **`docs/design/migration-doctrine.md` Rule 4 is stale.** It states the gate
   "Fails if any column is expected by the snapshot but absent from the DB
   (unapplied migration)". The implementation logs `[pending]` and exits 0. The
   code is correct here (migrations run after the gate); the doctrine document
   is wrong.
10. **Dead guard at `scripts/check-schema-drift.ts:155`** —
    `if (col === '__drizzle_migrations') continue;` compares a *column* name
    against a *table* name inside the per-column loop, so it can never fire.
    Harmless today; misleading to anyone extending the exclusion list.
11. **Nothing pins the deploy ordering.** No test asserts that
    `apps/web/package.json`'s `build` keeps `db:migrate &&` ahead of
    `next build`. CI builds with `build:only`, so dropping the migrate step
    would go green and ship code against an un-migrated database.
12. **`migrations:lint` is not wired into CI.** No workflow references it;
    journal coverage depends entirely on `affected-tests.sh` fanning out to
    `ALL` for `packages/core/` changes. It also runs only the ordering test, not
    the broader `migration-journal.test.ts`.

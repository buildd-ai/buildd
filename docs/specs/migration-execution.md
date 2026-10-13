---
title: DB Migration Execution
status: active
owner: max
last_verified: 2026-10-12
summary: Every committed migration MUST execute exactly once, recognised by its folder name (legacy history by its exact-ms journal time) and never by a high-water mark for post-cutover files; a missing tracking row for legacy history MUST be backfilled on evidence, never replayed.
domain: releases
surfaces: [packages/core/db/migrate.ts, packages/core/db/migrate-plan.ts, packages/core/db/migrate-drift.ts, scripts/check-schema-drift.ts]
related: [db-migration-gates, release-flow]
verified_by: [packages/core/__tests__/migrate-plan.test.ts, apps/web/tests/db/migration-baseline.test.ts, packages/core/__tests__/migrate-drift.test.ts, packages/core/__tests__/migrate-tree.test.ts, packages/core/__tests__/migrate-apply.test.ts, packages/core/__tests__/legacy-migrations.test.ts, packages/core/__tests__/migration-layout.test.ts, apps/web/tests/db/migration-layout-v1.test.ts]
keywords: [__drizzle_migrations, planMigrationsV1, drizzle v1, folder per migration, legacy map, snapshot rebase, high-water mark, last_migration_number, schema drift, 42703, backfill, toRun, toBackfill, forked snapshot chain, prevId, snapshot gap, resolveSnapshotSelection]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "migrator-uses-plan"
    type: "symbol_reachable"
    symbol: "planMigrationsV1"
    entry: "packages/core/db/migrate.ts"
    as: "call"
  - id: "migration-plan-v1"
    type: "symbol"
    name: "planMigrationsV1"
    path: "packages/core/db/migrate-plan.ts"
  - id: "migration-plan-tests"
    type: "test_file"
    path: "packages/core/__tests__/migrate-plan.test.ts"
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
replaces it with our own tree reader (`migrate-tree.ts`) and an explicit plan
(`planMigrationsV1`), because the stock behaviour is silently wrong in both
directions, and both directions reached production while the repo used the
journal layout:

| Failure | What happened | Fix |
|---|---|---|
| Silent skip | A migration carried a journal `when` below the applied mark. `db:migrate` exited 0, the deploy went green, and prod inserts threw `column ... does not exist` (42703) for hours. Two earlier migrations had been skipped the same way. | Post-cutover migrations have no mark at all: applied-ness is the row's `name`. |
| Blind replay | A custom runner read "no tracking row" as "never applied" and replayed the baseline's raw SQL, which recreated an index on a column a later migration had dropped. | A missing row is never replayed: legacy history is backfilled on evidence; a post-cutover file whose DDL is already present is recorded, not run. |

## Invariants

### Layout

- A migration is a folder `<YYYYMMDDHHMMSS>_<slug>/` holding `migration.sql` and
  `snapshot.json` (drizzle v1). There is no journal and no index. `readMigrationTree`
  is ours, not drizzle's, and fails closed: every entry in the directory MUST be a
  recognisable migration folder, because drizzle silently skips a folder with no
  `migration.sql` and never reads a stray root `.sql`, and either is a migration
  whose DDL would never run with the deploy still green.
- A migration's identity is its folder `name`, and its content hash is checked
  against the legacy map for legacy history. Editing an applied file's content is
  a CONTRACT violation under `db-migration-gates`.
- `drizzle-kit` and `drizzle-orm` are pinned to an exact rc version; CI asserts
  the *properties* we rely on (`up` is lossless, `generate` converges, `check`
  exits non-zero on a non-commuting pair), not the version string.

### Plan

- A migration is **applied** iff a tracking row carries its `name`, or (legacy
  history only) a row without a name has `created_at` equal to the migration's
  exact-ms `when` in the committed legacy map
  (`packages/core/db/legacy-migrations.json`, generated at cutover by
  `scripts/migrations-cutover.ts`). Keying legacy history on `created_at` alone
  after `drizzle-kit up` would plan the whole history as backfill (the folder
  timestamp is truncated to the second); keying on `name` alone would replay it.
- The tracking table gains `name` and `applied_at` through an additive,
  idempotent upgrade run under the migration lock; rows matched by exact-ms
  `when` are named. A named row whose `created_at` disagrees with the map, or an
  unnamed one at a legacy `when` naming something else, MUST abort the run.
- **Legacy history** keeps the frozen high-water mark and evidence-gated
  backfill: a legacy migration with no row at or below the legacy mark is
  recorded when the live schema shows its DDL, refused as
  `BackfillContradictedError` when it contradicts it, and never executed.
- **Post-cutover migrations have no high-water mark.** A file with no named row
  is executed. Before executing it, its replay-sensitive statements are checked
  against the live schema with the same evidence rules: DDL present -> record
  only; partly present -> refuse; absent or uncheckable -> execute.
- A comment-only migration (the cutover's snapshot rebase) is recorded without
  execution.
- `MIGRATE_EXPECT_NOOP=1` (the prod-clone dry run) MUST fail before executing
  anything if the plan is not empty.

### Baseline (squashed history)

- Every migration released up to and including `0250_shallow_bushwacker`
  (release `v0.284.0`) is squashed into the first folder
  (`packages/core/drizzle/20261006230118_baseline/migration.sql`): a schema-only
  `pg_dump` of a fresh database migrated through that history, one statement per
  `--> statement-breakpoint`. The individual files live in git history.
- The baseline is the legacy map's first entry (`baseline: true`) and carries the
  `when` of the last migration it absorbed. It runs **only on an empty tracking
  table**; a database at or past its `when` skips it even if its own row is
  missing. It is **never** a backfill candidate: introspecting a whole-schema
  dump proves nothing.
- A database with tracking rows whose legacy mark is **below** the baseline's
  `when` stopped partway through the squashed history. Planning MUST throw
  `PreBaselineDatabaseError`, naming `LAST_RELEASE_BEFORE_SQUASH`, **before any
  DDL, including the tracking-table upgrade**. **Self-hosted deployments must
  reach `v0.284.0` (or any later release before the squash) before upgrading
  past it.**
- The drift gate attributes every object the baseline creates to the baseline.
  `createTableColumns` and `deriveAssertions` read pg_dump's spelling (`public.`
  qualifiers, unquoted identifiers, `ALTER TABLE ONLY`) as well as drizzle-kit's.

### Cutover (one-time, reproducible)

- `scripts/migrations-cutover.ts` converts the legacy tree: it emits the legacy
  map, runs `drizzle-kit up` and asserts every legacy folder exists under its
  predicted name with identical bytes, roots the baseline snapshot (its parent was
  squashed away), then runs `generate` once. The kit renders partial-index
  predicates and CHECK constraints differently from 0.31, so that migration is
  representation churn: its `snapshot.json` is kept and its SQL becomes a comment
  (the **snapshot rebase**). A second `generate` MUST report nothing to migrate and
  `drizzle-kit check` MUST pass.
- On a database that already holds the history the result is zero DDL in
  `public`: only the rebase is recorded. The previous release's migrator, run
  against the upgraded tracking table, applies nothing and backfills nothing
  (it reads only `created_at`, and legacy rows keep their ms values), so a
  rollback after deploy is safe until the first real post-cutover migration.
- Removing the new columns is never automatic.

### Execution

- Each post-cutover file and its tracking insert run as **one** `db.batch` (a
  neon non-interactive transaction), so a dropped connection cannot leave DDL
  applied with no row. Two things a batch cannot carry run statement by statement
  instead and MUST then be idempotent (`IF NOT EXISTS`): statements Postgres
  refuses inside a transaction block (`CREATE INDEX CONCURRENTLY`), and `ALTER
  TYPE ... ADD VALUE` followed by a use of the new value in the same file.
- Legacy-layout statements (a fresh database running the baseline) execute one at
  a time with the tracking row inserted after the file, as before. The migrator refuses a legacy journal tree outright (the rc's own reader would).
- Two migrators at once MUST serialise: the migrator takes `__buildd_migrate_lock`
  and the second waits, then plans against what the first recorded.
- `CREATE SCHEMA IF NOT EXISTS drizzle` and `CREATE TABLE IF NOT EXISTS
  drizzle.__drizzle_migrations` run before the plan, so a fresh database
  bootstraps without manual setup.
- Only these errors are transient and retried (24 attempts, 5s apart, with a
  fresh connection each time): `endpoint is disabled`,
  `connect ECONNREFUSED`, `ENOTFOUND`, `password authentication failed`. Every
  other failure exits 1 immediately.
- A failing run MUST surface the Postgres detail: `cause.message`, `detail`,
  `hint` and `position` are printed alongside `message`.
- The process MUST exit explicitly on every path (0 on success, 1 on terminal
  failure). Production ordering comes from `apps/web/package.json`'s
  `"build": "bun run db:migrate && next build"`: a non-zero migrate exit means
  `next build` never runs, so no deploy can serve code against an un-migrated
  schema.

### Parallel branches

- Folder names are timestamps and slugs, so two branches cannot collide on a
  name and git merges their migrations cleanly. What git cannot see is that both
  snapshots name the same parent. `drizzle-kit check` (`bun run
  migrations:commute`, in CI on every PR and push) exits non-zero on a pair whose
  changes touch each other and passes on one whose changes do not.
- A leftover from before the cutover (a numbered `NNNN_x.sql`, a `meta/`
  directory) is refused by `bun run migrations:layout-check`, fail closed.
- `bun run migrations:regenerate` resets the drizzle dir to the base's exact
  state and re-runs `generate`, so the branch's schema change is re-diffed against
  the base's newest snapshot. It also moves a branch cut before the cutover onto
  the folder layout. A hand-written (`--custom`) migration is carried over
  verbatim; if the regenerated SQL differs from what it replaced the command exits
  3 and a person reads both.

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

- The gate compares production's `information_schema.columns` against the
  **chain tip** of the folder snapshots (`packages/core/drizzle/<name>/snapshot.json`,
  v8 `ddl[]` entities). It is read-only.
- The snapshot MUST be resolved through the `prevIds` chain, never by folder name
  sort alone. Snapshots form a graph; two concurrent `generate` runs fork it into
  siblings that each hold only part of the schema, and git conflicts on neither
  the `.sql` nor the `.json`. The baseline's snapshot is rooted (its parent was
  squashed away), so the chain has no gap at its start.
- **Parallel leaves are the schema's union, not a fork to refuse.** Under v1, two
  branches that each generated from one base leave two leaf snapshots, each holding
  the base plus only its own change, and nothing merges them until a later migration
  does. `drizzle-kit check` fails a pair whose changes touch each other in CI
  (`migrations:commute`), so by the time both are on a release the pair commutes:
  the gate MUST expect the union of the leaves' entities, log which leaves it
  used, and produce a verdict. (The legacy journal layout treated a fork at the tip
  as unverifiable and exited 2; that gate no longer reads a legacy tree and refuses
  one with exit 2.) A snapshot chain that cannot be read at all still exits 2, a
  code distinct from drift (`1`).
- A dangling older snapshot (successor removed by past renumbering) MUST be
  reported and MUST NOT be fatal. Several exist; failing on them would block
  every release to re-litigate settled history.
- A column or table present in the **snapshot but absent from the DB** MUST
  pass, logged `[pending]`. Migrations run at deploy, which is *after* this
  check, so a pending forward migration is the normal state of a release PR and
  must not block it.
- A column or table present in the **DB but absent from the snapshot** MUST be
  traced to a creating migration before any verdict, symmetrically with the
  missing-object path:
  - a migration drops it and has not run → `[pending]`, exit 0.
  - a journal migration creates it and `__drizzle_migrations` records that
    migration as applied → `[snapshot gap]`, exit 0. The object is tracked and
    applied; the resolved snapshot simply does not cover it.
  - no journal migration creates it → MUST fail with `EXTRA in DB` and the drift
    exit code. This is the ONLY fatal extra-object condition, and the only one
    that may be phrased as untracked manual DDL.
- The applied-migration count MUST be reported as a reconciliation (applied from
  this ref's journal + historical rows outside it), not printed beside the
  journal length. The tracking table is append-only apply history while the
  journal is only what the ref carries, so the two legitimately differ by the
  migrations that were renumbered or that predate a rebuilt journal. Side by side
  the two numbers read as production running migrations we do not know about.
- The CI migration check MUST assert on `bun db:generate`'s OUTPUT, not only its
  exit code. The 0.31 kit exited 0 after refusing to generate (a patch fixed the
  collision branch, and is gone with that kit); the rc kit exits non-zero, and the
  output check stays as a floor so a kit that goes quiet again cannot read as
  green. The check MUST echo the captured output before asserting.
- The applied-migration count MUST be read from `drizzle.__drizzle_migrations`
  with a fallback to `public.__drizzle_migrations`. Querying only `public`
  throws and reports 0, which is indistinguishable from "no migration ever ran"
  against a long-lived production DB.
- The `Schema Drift / check-prod` job MUST always emit success or failure and
  never GitHub's `Skipped` status — branch protection treats `Skipped` as
  satisfied. The gate is therefore a *step*-level condition: the job always
  runs, exits 0 immediately when `base_ref != main`, and performs the real check
  only for dev→main.
- A PR that touches `packages/core/drizzle/` runs the **full** unit suite
  (`scripts/affected-tests.ts`): the tests that read the migrations tree whole name
  no migration folder, so no per-file selection can find them. Pushes to `dev` and
  PRs into `main` run the full suite anyway.

## Acceptance criteria

- AC-1: GIVEN a v1 tree of three folders and a legacy map naming the first two,
  tracking rows for the first only (by exact-ms `created_at`, unnamed) and a
  legacy mark at that `when` WHEN `planMigrationsV1` runs THEN the row is named,
  the second legacy folder is evidence-checked (recorded, not replayed) and the
  post-cutover folder is in `toRun`.
- AC-2: GIVEN a database with no tracking rows WHEN `planMigrationsV1` runs THEN
  the baseline and every later folder are in `toRun` and nothing is backfilled.
- AC-3: GIVEN a tracking row whose `created_at` is the string `'100'` and a legacy
  migration whose `when` is `100` WHEN `planMigrationsV1` runs THEN it is applied
  and neither run nor backfilled: `created_at` compares numerically whether the
  driver returns a string or a number.
- AC-B1: GIVEN a tree whose first entry is the baseline and an empty tracking
  table WHEN the plan runs THEN the baseline and every later entry are in `toRun`.
- AC-B2: GIVEN tracking rows whose legacy mark equals the baseline's `when` WHEN
  the plan runs THEN the baseline is neither run nor backfilled and only later
  entries run.
- AC-B3 (failure path): GIVEN tracking rows whose legacy mark is below the
  baseline's `when` WHEN the plan runs THEN it throws `PreBaselineDatabaseError`
  naming `LAST_RELEASE_BEFORE_SQUASH`, and nothing runs, including the tracking
  upgrade.
- AC-B4: GIVEN a fresh database migrated through the pre-squash tree and another
  migrated through the squashed tree WHEN both schemas are fingerprinted THEN
  they are identical.
- AC-4 (failure path): GIVEN a migrations directory holding a legacy `NNNN_x.sql`
  or a `meta/` directory next to v1 folders WHEN the tree is read or
  `migrations:layout-check` runs THEN it fails, naming the file: v1 would never
  read it.
- AC-5 (failure path): GIVEN a folder with no `migration.sql` WHEN the tree is
  read THEN it throws (drizzle would skip it silently) and zero migrations run.
- AC-6 (failure path): GIVEN two branches that each generated a migration from one
  base and whose changes touch each other WHEN they are merged THEN
  `migrations:commute` exits non-zero; GIVEN changes that do not touch each other
  THEN it exits 0 with no repair needed.
- AC-6b: GIVEN the cutover on a database that already holds the full history WHEN
  the migrator runs THEN no DDL runs in `public`, only the rebase is recorded, a
  rerun plans nothing, and the previous release's migrator then applies nothing.
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
  resolved snapshot does not declare AND no migration in the journal creates it
  WHEN `scripts/check-schema-drift.ts` runs THEN it prints
  `EXTRA in DB    : tasks.hotfix_note — no migration in the journal creates it  ← untracked manual DDL`
  and exits 1.
- AC-12b: GIVEN production has a table the resolved snapshot does not declare
  BUT a journal migration creates it and `__drizzle_migrations` records that
  migration as applied WHEN the gate runs THEN it logs `[snapshot gap]` naming
  that migration and exits 0 — it MUST NOT report drift.
- AC-12c: GIVEN two leaf snapshots that share a parent (two parallel migrations)
  WHEN the gate runs THEN it logs both leaves, expects the union of their entities,
  and returns a verdict: a table either branch added is expected, not "untracked
  manual DDL". GIVEN a legacy journal tree THEN it exits 2 ("cannot verify"), not 1.
- AC-12d: GIVEN a snapshot whose successor was removed by past renumbering WHEN
  the gate runs THEN it notes the dangling snapshot and proceeds to a verdict.
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
| `planMigrationsV1`, `MigrationPlanV1` (name-keyed plan) | `packages/core/db/migrate-plan.ts` |
| tree reader (fail closed), layout detection | `packages/core/db/migrate-tree.ts` |
| legacy map and its tree check | `packages/core/db/legacy-migrations.ts`, `packages/core/db/legacy-migrations.json` |
| per-file atomic apply (`db.batch`) | `packages/core/db/migrate-apply.ts` |
| cutover script | `scripts/migrations-cutover.ts` |
| layout check, commute check, regenerate | `packages/core/db/migration-layout.ts` |
| `workspaces.lastMigrationNumber` | `packages/core/db/schema.ts:630` |
| slot reservation (atomic UPDATE+RETURNING) | `apps/web/src/app/api/workspaces/[id]/migration-slot/route.ts:54-61` |
| slot auth / 404 / zero-pad | `apps/web/src/app/api/workspaces/[id]/migration-slot/route.ts:35-38,63-68` |
| agent-facing reserve-then-generate flow | `apps/web/src/lib/default-roles.ts:212-227` |
| drift gate: snapshot resolution, leaf union | `scripts/check-schema-drift.ts` (`latestSnapshot`), `packages/core/db/migrate-drift.ts` (`snapshotLeaves`, `unionLeafDdl`) |
| drift gate: tracking-count schema fallback | `scripts/check-schema-drift.ts:244-270` |
| drift gate: exit codes (drift vs cannot-verify) | `scripts/check-schema-drift.ts:69-70` |
| `loadSnapshotMetasV1`, `resolveSnapshotSelectionV1`, `snapshotChainGaps` | `packages/core/db/migrate-drift.ts` |
| `classifyExtraSchemaObjects` (creator tracing) | `packages/core/db/migrate-drift.ts:344-400` |
| `reconcileAppliedCount` | `packages/core/db/migrate-drift.ts:419-445` |
| `Schema Drift / check-prod` job (step-level gate) | `.github/workflows/build.yml:313-345` |
| "migrations are up to date" PR check (asserts on exit code AND output) | `.github/workflows/build.yml:84-120` |
| preview-branch migrate | `.github/workflows/build.yml:409-411` |
| deploy ordering (`db:migrate && next build`) | `apps/web/package.json:7` |
| `migrations:lint` (prod build runs migrations), `migrations:layout-check`, `migrations:commute`, `migrations:regenerate` | `package.json` |
| migration change → full unit suite | `scripts/affected-tests.ts` |
| squashed baseline (released history up to the cut) | `packages/core/drizzle/20261006230118_baseline/migration.sql` |
| `PreBaselineDatabaseError`, `LAST_RELEASE_BEFORE_SQUASH` | `packages/core/db/migrate-plan.ts` |
| squash equivalence proof (old tree vs new tree, real Postgres) | `apps/web/tests/db/migration-baseline.test.ts` |

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
6. **(closed)** The journal ordering check and its merge-race blind spot are gone with the journal: post-cutover files have no mark to out-rank.
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
12. **`migrations:lint` guards one thing now** (the prod build runs migrations); the journal tests it used to run are gone. `migrations:layout-check` and `migrations:commute` are wired into `build.yml` and are the parallel-branch guards.

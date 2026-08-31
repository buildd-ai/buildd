# Migration Doctrine

## Motivation: 2026-07-10 Outage

On 2026-07-10, the `tasks` table was missing the `path_manifest` column in production for approximately 7 hours. Root cause: a developer applied DDL directly to the production database (manual `ALTER TABLE`) without creating a corresponding Drizzle migration file. When a subsequent schema.ts change was deployed, migrations ran but did not cover the manually-applied column, leaving the schema file and the database in an inconsistent state.

This was the second migration-drift incident to reach production. The first was resolved via PR #1150 (journal reconciliation). These incidents share a common root-cause class: **the schema.ts file can diverge from the committed migration history, and the build can still deploy**.

## Doctrine

### Rule 1: Every schema change ships with its migration in the same PR

`packages/core/db/schema.ts` changes **must** be accompanied by a generated migration file (`packages/core/drizzle/NNNN_*.sql`) in the same pull request. CI enforces this by regenerating migrations and failing if `git status drizzle/` shows any changes.

**How to comply:**
```bash
cd packages/core
bun db:generate        # generates the migration file
git add drizzle/       # commit the generated files
```

CI fails on schema.ts changes with no committed migration. No exceptions.

### Rule 2: Migrations run before or atomically with code promotion

Vercel runs `db:migrate` as part of the deploy hook — migrations execute before the new code version begins serving traffic. Never bypass this by:
- Commenting out the migrate step in the deploy hook
- Using `db:push` in any environment (it bypasses migration tracking)
- Applying DDL outside of the migration system

### Rule 3: Manual hotfix DDL must be followed by a journal-reconciliation PR within one working day

If an emergency requires manual DDL on production (e.g., `ALTER TABLE` via psql), you must:

1. Apply the DDL to production.
2. Immediately open a `chore(db): reconcile [table] after manual hotfix` PR that:
   - Adds the equivalent migration file to `packages/core/drizzle/`
   - Updates `drizzle/meta/_journal.json` to include the new entry
   - Documents the incident in the PR description
3. Merge the reconciliation PR within one working day.

This pattern was established after the 0067_tasks_path_manifest incident (PR #1150).

### Rule 4: The pre-promote schema-drift gate must pass before any release merges to main

A required CI check (`Schema Drift / check-prod`) compares the production database's actual column structure against the Drizzle migration snapshot before any release PR merges to `main`. This check:

- Introspects `information_schema.columns` on the production database (read-only)
- Compares against the expected schema from `packages/core/drizzle/meta/<latest>_snapshot.json`
- Fails if any column exists in the DB but not in the snapshot (manual DDL not tracked),
  **unless** a migration drops that column — migrations run on deploy, after this gate,
  so a column awaiting its `DROP COLUMN` is expected, not drift
- For an object the snapshot expects that the DB does **not** have, the verdict depends on
  `__drizzle_migrations`, because "missing" alone is ambiguous this early in the deploy:
  - the migration that adds it is **not** recorded as applied → `[pending]`, gate passes.
    Migrations run during the deploy, i.e. after this gate, so this is the normal state of
    any release that carries a migration.
  - the migration that adds it **is** recorded as applied → **fails**. A migration that
    "ran" without its DDL taking effect is the 0067-class silent skip, or a tracking row
    written without the DDL ever running.
  - **no** migration in the journal adds it → **fails** (unattributable).
- Sends a Pushover alert (via `PUSHOVER_TOKEN_ALERT`) on any gate failure

Historical note: until this was corrected, the gate logged `[pending]` for *every* missing
column and exited 0, while this document claimed it failed on any missing column. That gap is
what let a bogus tracking-row backfill (see Rule 5) pass unnoticed. Classification logic:
`packages/core/db/migrate-drift.ts` (unit-tested); the gate script prints the counts behind
each verdict so a scan that compared nothing cannot read as a pass. Run
`bun run scripts/check-schema-drift.ts --offline` to exercise everything except the database.

**To add this as a required check:** go to GitHub → Settings → Branches → `main` → Require status checks → add `Schema Drift / check-prod`.

### Rule 5: A migration is recorded as applied only if its statements ran

`packages/core/db/migrate.ts` splits untracked migrations two ways (`packages/core/db/migrate-plan.ts`):

- **newer** than the `__drizzle_migrations` high-water mark → execute the SQL, then record.
- **older** than the high-water mark → a *candidate* for a tracking-row backfill, because a
  missing row there can mean "ran, but the tracking insert was lost". It is not proof of that,
  so the backfill must now **prove** it: `migrate-backfill.ts` derives assertions from the
  migration's own SQL (`ADD COLUMN` → that column exists, `DROP TABLE` → that table is gone,
  `CREATE INDEX` → that index exists, FK `DO $$` blocks → that constraint exists) and checks
  them against live `information_schema` introspection.
  - assertions all hold → record the tracking row.
  - any assertion fails → **abort the deploy**, record nothing. The migration never ran; a
    tracking row would make the skip permanent, because the next run would then skip it
    forever. Resolve it the way `0074_reconcile_missions_secret_refs_drift.sql` did: a new
    reconciliation migration re-issuing the equivalent idempotent DDL under current names.
  - nothing in the file is checkable (pure data DML) → abort, unless the operator sets
    `MIGRATION_BACKFILL_ALLOW_UNVERIFIED=1`, which records it with a loud log line.

Previously this loop inserted a tracking row without ever reading `migration.sql`, exited 0,
and the drift gate reported the missing column as `[pending]`. Silent, permanent schema loss.

### Rule 6: Only one migrator runs at a time

Two deploys overlapping used to both read `__drizzle_migrations` before either wrote, compute
the same work, and race through it. 142 of the committed `ADD COLUMN` statements have no
`IF NOT EXISTS`, so the loser fails mid-file and can leave a multi-statement migration
half-applied under a tracking row that claims success.

`migrate.ts` now takes a lock before the apply loop and releases it in a `finally`. It is a
lock **row** (`drizzle.__buildd_migrate_lock`) taken by one atomic `INSERT ... ON CONFLICT DO
UPDATE ... WHERE acquired_at < now() - <stale window> RETURNING holder`, **not**
`pg_advisory_lock`: the migrator runs on the `@neondatabase/serverless` HTTP driver, where
"sessions and transactions are not supported", so a session-scoped advisory lock would be
released before the next statement and would provide no exclusion at all. A second migrator
waits, then finds nothing to do. A lock held past the staleness window (15 min) is taken over,
so a crashed deploy cannot wedge future ones.

## Summary: The Decision Tree

```
Schema change needed?
  ├── Yes → edit schema.ts + run bun db:generate + commit both in same PR
  │         CI will verify; your PR cannot merge without the migration file.
  │
  └── Emergency? Need DDL on production NOW?
        ├── Apply DDL manually (hotfix)
        └── Open reconciliation PR within 1 working day (Rule 3)
              └── Schema-drift gate will block the next release until
                  the reconciliation PR merges first
```

## Enforcement Checklist

- [ ] `build` job in `build.yml`: regenerates + checks migrations (existing)
- [ ] `Schema Drift / check-prod` job in `build.yml`: introspects production DB on release PRs (new)
- [ ] `main` branch protection: `Schema Drift / check-prod` is a required status check
- [ ] Pushover alert sent when either gate fails (`PUSHOVER_TOKEN_ALERT` + `PUSHOVER_USER` GitHub secrets)
- [x] `bun run migrations:lint` (pre-commit hook): journal `when` ordering across the WHOLE
      journal, plus `apps/web`'s `build` script still carrying `db:migrate &&` — the only path
      by which migrations reach production. CI builds with `build:only`, so deleting that
      prefix used to ship green as a silent no-migrate deploy.
- [ ] `bun run migrations:lint` added as a CI step in `build.yml`. Not done: `build.yml` is
      outside the scope of the change that added this line. Until then the only always-on
      enforcement is the pre-commit hook, plus the unit tests (which CI skips for a PR that
      touches nothing but `package.json`, per `scripts/affected-tests.sh`).

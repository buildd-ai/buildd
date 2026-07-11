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
- Fails if any column exists in the DB but not in the snapshot (manual DDL not tracked)
- Fails if any column is expected by the snapshot but absent from the DB (unapplied migration)
- Sends a Pushover alert (via `PUSHOVER_TOKEN_ALERT`) on any gate failure

**To add this as a required check:** go to GitHub → Settings → Branches → `main` → Require status checks → add `Schema Drift / check-prod`.

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

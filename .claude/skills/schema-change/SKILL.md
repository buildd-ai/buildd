---
name: schema-change
description: "Ship a Drizzle schema change in buildd without losing a migration, a column, or a release. Covers generating migrations (drizzle v1 folders), parallel branches whose migrations do not commute, dropping things safely, and unblocking the release drift gate."
author: buildd
---

# Shipping a Schema Change

`packages/core/db/schema.ts` is the source of truth. Everything else — the SQL in
`packages/core/drizzle/` folders and their snapshots — is **generated**. The whole
skill is one rule and its consequences:

> **Generate. Never hand-edit a migration or a snapshot.**

Hand-editing is how a snapshot stops describing the schema, and a snapshot that
lies is invisible until a deploy fails or a column silently isn't there.

## The normal path

```bash
# 1. edit packages/core/db/schema.ts
cd packages/core && bun db:generate     # emits drizzle/<YYYYMMDDHHMMSS>_<slug>/{migration.sql,snapshot.json}
# 2. read the emitted SQL. Every time. It is short.
# 3. commit schema.ts AND the new folder together
```

CI fails if `schema.ts` changed without committed migration files. Migrations
auto-run on Vercel deploy. **Never `db:push`** — it bypasses migration tracking.

## Parallel branches: names cannot collide, intent can

drizzle v1 keeps each migration in its own folder named by a timestamp and slug,
with no journal and no index. Two sessions that each run `db:generate` get
different folders, so **git merges them cleanly and warns about nothing**. What it
cannot see is that both snapshots name the same parent: the second migration's SQL
was diffed against a schema the first already changed. Whether that matters depends
on whether the two changes touch each other (the same table or column), which is
what the kit's own `check` decides.

**Before every push that touches `drizzle/`** (CI runs both on every PR):

```bash
git fetch -q origin dev && git merge origin/dev     # resolve schema.ts conflicts on their merits
bun run migrations:layout-check --base=origin/dev   # fails closed on a leftover legacy file
bun run migrations:commute                          # drizzle-kit check: do the pair commute?
cd packages/core && bun db:generate                 # must say "No schema changes"
```

If `commute` fails, or `generate` finds something, or the merge changed `schema.ts`
under your migration, repair it with the tool, never by hand:

```bash
bun run migrations:regenerate --base=origin/dev
```

`migrations:regenerate` resets `packages/core/drizzle/` to dev's exact state,
re-runs `drizzle-kit generate` with your migration's name, and stages the result.
A hand-written `--custom` migration is re-minted with its SQL carried verbatim.
Exit 3 means the regenerated SQL differs from what it replaced: read both before
committing. For a conflicted merge, `bun run conflicts:generated` calls it for you.
Proof in `packages/core/__tests__/migration-layout.test.ts`, which runs the pinned
kit on two real branches.

**A branch cut before the cutover** has a `meta/_journal.json` and a numbered
`NNNN_x.sql`. drizzle v1 never reads a numbered file, so its DDL would be skipped
with the deploy green; `migrations:layout-check` and the merge-safety inspector both
refuse it. Merge dev, then `migrations:regenerate`: your schema change comes back as
a v1 folder.

**Only the tools move a migration.** On a dev→mission refresh PR the merge-safety
inspector reads "mission migration deleted, a new one with the same bytes added" as
a move and lets it through (docs/specs/db-migration-gates.md, "A renumber in a
refresh PR is not lineage"). A rename, a hand-edited file, or SQL that changed on
the way is lineage and goes to a person.

**Regenerate rather than edit by hand.** Regeneration re-diffs your `schema.ts`
against dev's *newest* snapshot, so a column another session added in the same
window survives in yours. A hand-edited snapshot describes a schema that no longer
exists.

## How a migration is recognised as applied

There is no high-water mark for post-cutover migrations: each one is applied iff a
tracking row carries its folder `name`, and each file runs with its tracking insert
as one atomic batch. Legacy history is recognised through the committed legacy map
(`packages/core/db/legacy-migrations.json`), by exact-ms `created_at`. A migration
that is untracked but whose DDL is already in the database is recorded, not replayed;
partly present DDL is refused. Spec: `docs/specs/migration-execution.md`.

One exception, on a throwaway database only: `visual-qa.yml` sets
`MIGRATION_CI_CLONE_APPLY_ABSENT=1` (honoured only in GitHub Actions) so a
mission branch's untracked migration whose DDL is **wholly** absent is executed on
the prod clone instead of refused. Partly present DDL still fails there, and prod
deploys never see the flag.

## The squashed baseline

Every migration released up to `v0.284.0` (through `0250_shallow_bushwacker`)
lives in one folder, `drizzle/20261006230118_baseline/migration.sql`: a `pg_dump` of
the schema, which the legacy map (`packages/core/db/legacy-migrations.json`) flags as
the baseline. The old files and
snapshots are in git history before the squash. Read them with
`git show v0.284.0:packages/core/drizzle/<file>.sql`, not from the tree.

- **Never edit the baseline.** It runs only on an empty tracking table, which
  means fresh DBs: CI, demo, local Docker. Every released DB skips it. A change
  belongs in a new migration, as always.
- New migrations are timestamped folders; `db:generate` names them for you.
- A DB with tracking rows whose newest row is older than the baseline's `when`
  fails with `PreBaselineDatabaseError`. Migrate it with `v0.284.0` first, or
  start it fresh. Do not hand-insert tracking rows to get past it.
- To squash again later, cut only at a migration that is on `main`. Prod has to
  hold that migration's row, or every released DB would hit the error above.

## Dropping a table or column

`db:generate` will happily emit `DROP TABLE ... CASCADE` and `DROP COLUMN` the
moment you delete something from `schema.ts`. Before that ships:

1. **Check the code is really done with it.** Grep for the *column accessor*
   (`.myColumn`), not the snake_case string — a string like `'anthropic_api_key'`
   is often an unrelated enum value (e.g. a `secrets.purpose`), so a bare grep
   makes a dead column look live.
2. **Count what you are destroying, in production.** Cheap, and it turns
   "probably fine" into a fact:
   ```bash
   vercel env pull /tmp/.env.prod --environment=production --yes   # from a linked checkout
   # then a tagged-template neon query — the neon client REQUIRES sql`...`,
   # sql('text') throws
   ```
   Report the counts in the PR. "Eight rows, all identical and redundant" is a
   decision someone can sign off; "should be empty" is not.
3. A `DROP COLUMN IF EXISTS` with a comment explaining why nothing wrote it is
   the shape to aim for — re-runs stay harmless and the reasoning survives.

## When the release drift gate blocks you

`Schema Drift / check-prod` on a `Release vX.Y.Z` PR compares **live production**
against the newest snapshot. Pending forward migrations are fine. Two failure
modes:

- **`EXTRA TABLE/COLUMN … ← untracked manual DDL`** where the object is one your
  branch *drops*. This is a catch-22: the migration that removes it cannot run
  until the release deploys, and the gate blocks that merge. Unblock by applying
  migrations to prod ahead of the merge, from a checkout that has them:
  ```bash
  cd packages/core && DATABASE_URL=<prod> bun db:migrate
  DATABASE_URL=<prod> bun run scripts/check-schema-drift.ts   # expect 0 drift, 0 unexplained
  ```
  Do the drop audit above **first** — this is irreversible.
- **Genuine drift** (someone applied DDL by hand). Do not hand-insert tracking
  rows. Write a reconciliation migration that re-issues the equivalent
  *idempotent* DDL under current names.

Note `bun db:migrate` takes a lock, so it is safe against a concurrent deploy.

## Verifying a deploy actually shipped

`/api/version` reports the **repo's** latest commit and tag, not the deployed
one — it will look correct while a deploy is still building or has failed. The
honest signal is the Vercel deployment state:

```bash
u=$(vercel ls --prod | sed 's/\x1b\[[0-9;]*m//g' | grep -oE 'https://[a-z0-9-]+\.vercel\.app' | head -1)
vercel inspect "$u" | grep -i status     # want: ● Ready
```

`vercel ls` prints only URLs when stdout is not a TTY, so a `grep Building` loop
against it exits immediately and looks like success. Poll `vercel inspect`.

## Checklist

- [ ] `schema.ts` edited, `bun db:generate` run, emitted SQL read
- [ ] `schema.ts` and `drizzle/` committed together
- [ ] dev merged in, then `bun run migrations:layout-check --base=origin/dev` and `bun run migrations:commute` pass and `bun db:generate` reports no changes, immediately before pushing
- [ ] anything dropped: code checked by accessor, prod rows counted, numbers in the PR
- [ ] no `db:push`, no hand-edited snapshot/SQL, no renamed migration folder

---
name: schema-change
description: "Ship a Drizzle schema change in buildd without losing a migration, a column, or a release. Covers generating migrations, the index collisions that happen several times a day with concurrent sessions, dropping things safely, and unblocking the release drift gate."
author: buildd
---

# Shipping a Schema Change

`packages/core/db/schema.ts` is the source of truth. Everything else — the SQL in
`packages/core/drizzle/`, the snapshots, the journal — is **generated**. The whole
skill is one rule and its consequences:

> **Generate. Never hand-edit a migration, a snapshot, or the journal.**

Hand-editing is how a snapshot stops describing the schema, and a snapshot that
lies is invisible until a deploy fails or a column silently isn't there.

## The normal path

```bash
# 1. edit packages/core/db/schema.ts
cd packages/core && bun db:generate     # emits drizzle/NNNN_*.sql + meta/
# 2. read the emitted SQL. Every time. It is short.
# 3. commit schema.ts AND drizzle/ together
```

CI fails if `schema.ts` changed without committed migration files. Migrations
auto-run on Vercel deploy. **Never `db:push`** — it bypasses migration tracking.

## Index collisions — expect these, they are not bad luck

Many sessions work this repo at once and each runs `db:generate`. A branch open
for a few hours routinely collides two to four times. Git will **not** warn you:
the `.sql` files have different generated names so they merge cleanly; only
`meta/_journal.json` and the snapshot conflict. A collision can survive a
clean-looking merge and only show up as a failed deploy.

**Check immediately before every push that touches `drizzle/`:**

```bash
git fetch -q origin dev
git show origin/dev:packages/core/drizzle/meta/_journal.json | python3 -c \
  "import json,sys;e=json.load(sys.stdin)['entries'];print(e[-1]['idx'],e[-1]['tag'],e[-1]['when'])"
python3 -c \
  "import json;e=json.load(open('packages/core/drizzle/meta/_journal.json'))['entries'];print(e[-1]['idx'],e[-1]['tag'],e[-1]['when'])"
```

If dev's newest `idx` is **>= yours**, fix it before pushing:

```bash
git rebase origin/dev                    # resolve non-drizzle conflicts normally
# take dev's migration state wholesale:
git checkout origin/dev -- packages/core/drizzle/meta/_journal.json \
                           packages/core/drizzle/meta/<theirs>_snapshot.json \
                           packages/core/drizzle/<theirs>.sql
rm packages/core/drizzle/<yours>.sql     # drop your colliding one
git add -A packages/core/drizzle && git rebase --continue
cd packages/core && bun db:generate      # regenerate on top of dev
```

**Regenerate rather than renumber by hand.** Regeneration re-diffs your
`schema.ts` against dev's *newest* snapshot, so a column another session added in
the same window survives in yours. Hand-editing `idx`/`when` leaves a snapshot
describing a schema that no longer exists.

Then verify, and actually read the file — `cat` the number you just generated,
not the one you expected:

```bash
ls packages/core/drizzle/*.sql | tail -1     # confirm the number
cat packages/core/drizzle/<new>.sql          # confirm the SQL is still your intent
python3 -c "import json;e=json.load(open('packages/core/drizzle/meta/_journal.json'))['entries'];print('monotonic:', e[-1]['when'] > e[-2]['when'])"
```

`packages/core/__tests__/migration-journal-ordering.test.ts` guards the ordering.

## Why monotonic `when` still matters

The migrator applies by a `when` high-water-mark, so a lower-`when` migration is
not executed blind. **This is not the old silent-skip hazard** — `migrate.ts`
routes an untracked below-mark migration to `backfillTrackingRows`, which
introspects the live schema and throws `BackfillContradictedError` if the DDL is
genuinely absent. So a collision is a **loud failed deploy**, not a missing
column. That is why it must be fixed before merging, not discovered after.

Do not try to "fix" the handful of historical below-mark journal entries. They
predate the guard and production has their DDL.

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
- [ ] journal compared against `origin/dev` immediately before pushing
- [ ] newest `when` strictly greater than its predecessor
- [ ] anything dropped: code checked by accessor, prod rows counted, numbers in the PR
- [ ] no `db:push`, no hand-edited journal/snapshot/SQL

---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "change-intents-table"
    type: "symbol"
    name: "changeIntents"
    path: "packages/core/db/schema.ts"
  - id: "migration-slot-reservation"
    type: "route"
    method: "POST"
    path: "/api/workspaces/[id]/migration-slot"
    file: "apps/web/src/app/api/workspaces/[id]/migration-slot/route.ts"
  - id: "change-intent-tests"
    type: "test_file"
    path: "apps/web/src/lib/change-intent.test.ts"
---
# Change-Intent Announcements

**Status:** Implemented — §1–7 deployed (schema, API, anchor injection, conflict detection, migration-slot, stale-branch guard, webhook close). §8 remains explicitly deferred.  
**Scope:** conflict-surface serialization, stale-branch guard, migration-slot reservation  
**Priority surfaces:** `packages/core/db/schema.ts`, `packages/core/drizzle/` (migrations), `bun.lock`, role prompt files

---

## Problem

Concurrent agent PRs repeatedly collide on shared surfaces. Known collision classes:

| Surface | Collision mechanism |
|---------|-------------------|
| Drizzle migrations | Two branches both mint `NNNN_<distinct>.sql`; same integer index, different filenames — git detects no overlap |
| `bun.lock` | Concurrent dep additions produce merge conflicts |
| Role prompts / shared fixtures | Parallel edits to the same file |
| Stale branches | Branch diverges >20 commits from dev; CI fails on environment drift |

The root cause documented in memory: `pathsOverlap()` performs exact-path and directory-prefix matching only. Distinct filenames with the same migration index are invisible to it.

---

## Design

### 1. Declared conflict surfaces (workspace config)

Extend `WorkspaceGitConfig` (JSONB — no migration needed) with:

```typescript
conflictSurfaces?: Array<{
  pattern: string;  // glob or prefix, e.g. "packages/core/drizzle/**", "bun.lock"
  label: string;    // shown in warnings, e.g. "Drizzle migrations"
}>;
sequenceNamespaces?: Array<{
  dir: string;       // e.g. "packages/core/drizzle"
  anchorFile: string; // e.g. "packages/core/drizzle/meta/_journal.json"
  label: string;     // e.g. "Drizzle migrations"
}>;
```

`conflictSurfaces` drives post-PR warnings.  
`sequenceNamespaces` drives pathManifest auto-injection at task-creation time (see §3).

### 2. changeIntents table

New first-class table `change_intents`:

```sql
CREATE TABLE change_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  surface VARCHAR(500) NOT NULL,   -- the matched conflictSurface label
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  pr_number INT,
  branch VARCHAR(500),
  head_sha VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX change_intents_workspace_surface_idx
  ON change_intents(workspace_id, surface) WHERE closed_at IS NULL;
```

### 3. Sequence-namespace anchor injection (create_task)

When a task declares a `pathManifest` that overlaps a `sequenceNamespace.dir`, the create_task API auto-appends the `anchorFile` to `pathManifest`. This makes the claim route's `findBlockingPr()` serialise schema tasks — eliminating the integer-namespace collision class at the source.

Example: a task with `pathManifest: ["packages/core/db/schema.ts"]` gets `packages/core/drizzle/meta/_journal.json` appended automatically.

### 4. Conflict-surface check + warning at create_pr

After a PR is successfully opened, the `POST /api/github/pr` route:

1. Resolves the task's `pathManifest` against the workspace's `conflictSurfaces` globs.
2. Records a `changeIntents` row for each matched surface.
3. Finds other **open** `changeIntents` rows for the same workspace + surfaces.
4. For each counterpart, posts a `warning` note on both the current task and the counterpart task, naming the other PR URL and the surface in conflict.

Default action: **warn + guide**, never hard-block.

For migrations specifically, the warning instructs the later branch to `git rebase` onto the earlier branch (or renumber its migration file).

### 5. Migration-slot reservation

A dedicated API endpoint for atomic migration-number handout:

```
POST /api/workspaces/[id]/migration-slot
→ { nextNumber: 106, formatted: "0106" }
```

Internally: `UPDATE workspaces SET last_migration_number = last_migration_number + 1 RETURNING last_migration_number`. Uses a new `last_migration_number` column (integer, default 0).

The Builder role instructions are updated to call this endpoint before running `bun db:generate`.

### 6. Stale-branch guard (runner)

In `git-operations.ts`, immediately after `git fetch origin`:

```
commitsBehind = git rev-list --count HEAD..origin/<defaultBranch>
```

If `commitsBehind > 10`, emit a strong warning message visible in the runner UI, with instructions to rebase before pushing. The guard is non-blocking (warn only) — forced rebase could discard valid in-progress work.

### 7. Intent lifecycle

- **Open**: recorded when `create_pr` fires for the first time (not on dedup returns).
- **Close**: marked `closedAt = NOW()` in the GitHub PR webhook when `action === 'closed'` or `action === 'merged'`.
- **Supersession**: CI retry chains call `create_pr` on the same `workerId` / same task — the dedup path returns early without creating a duplicate intent row. Superseded-PR retries (new worker, same task) inherit the intent via the existing worker→task linkage.

### 7a. Opt-in merge ordering on serialized surfaces

Added by [conflict-aware-orchestration](conflict-aware-orchestration.md) §3
(`apps/web/src/lib/surface-ordering.ts`). Everything above stays advisory by
default. A workspace opts in with `gitConfig.surfaceOrdering: 'shadow' | 'enforce'`
**and** `serialize: true` on a `conflictSurfaces` or `sequenceNamespaces` entry;
without both, no merge door reads anything new.

- A namespace entry may list `triggers` (e.g. `packages/core/db/schema.ts`): a
  manifest touching a trigger gets the anchor injected (§3), and a PR diff
  touching one counts as touching the namespace. Generated files (journal,
  snapshots) count too, despite their edit-lease exemption.
- Every merge door (unattended auto-merge, the landing function, the dashboard
  merge, `merge_pr`) asks the same guard before any branch mutation: a PR waits
  while an earlier open PR (by earliest open intent, then PR number) shares a
  serialized surface **and lands on the same base branch**. Surfaces come from
  the PR's pinned actual diff; an unreadable diff or intent state defers in
  `enforce`.
- Contention is per (repository, base branch): a mission integration PR never
  waits on, or holds up, its own task PRs that target the integration branch,
  and a trunk PR never waits on a PR that only targets a mission branch. The
  mission PR still serializes against other trunk PRs when it goes to trunk.
  Intent rows record the PR's base (`base_ref`); a row with none counts until
  a live read says the PR lands elsewhere.
- Intent rows are now deduplicated per (workspace, PR, surface) with a guarded
  insert; a task-less row still counts as a contender.
- The merge itself runs inside a per-surface, per-base reservation
  (`surface_reservations`, one atomic compare-and-set), released on success or failure, expiring after a
  bounded TTL and reconciled against GitHub before reuse.
- Closing a PR (webhook or the reconcile sweep, which also catches a lost close
  event) closes its intents and re-drives the next waiting PR. No session waits.
- Retargeting a PR (the `pull_request` `edited` webhook carrying
  `changes.base`, including GitHub's own retarget to trunk when a mission
  branch is deleted) moves that PR's open intents to the new `base_ref`. The
  row update runs in every mode: it only keeps a recorded fact true and costs
  one indexed write on a rare event. Under `enforce` it also re-drives the
  head of the old lane (the PR left it) and of the new lane (the PR may now
  head it). Without this, other PRs on the new base did not see the
  retargeted PR until its own guard ran. Reservations always used the live
  base, so two PRs could still never merge at the same moment, but they could
  land in the wrong order.
- **Known gap: intents are not scoped by repository.** `change_intents` has
  no repo column, so in a workspace backed by more than one repository, PRs
  in different repos that share a serialized surface label are treated as
  contenders against each other. Two different repos can also have PRs with
  the same number, and those rows look like one PR. Reservations
  (`surface_reservations`) do include the repo, so this can over-serialize
  across repos (a PR waits on another repo's PR) but cannot make two merges
  run in the same lane at once. The fix is a `repo_full_name` column on
  `change_intents` that the create_pr / guard writers fill and every intent
  predicate filters on. That needs a migration, so it is left for its own
  change. Deriving the repo from the PR URL does not work for intent rows:
  they carry no URL, and a row whose task is gone (`task_id` set null) has
  nothing to join through.
- Warnings stay `change_intent` / `warned` (`detail.advisory`); ordering waits
  are the separate `surface_ordering` gate. The migration-slot reservation and
  collision checks (§5, the merge-time migration inspector) remain as backstops.

### 8. Announcement surface (future)

Intent rows are queryable via `GET /api/workspaces/[id]/change-intents?open=true`. The mission timeline can surface a badge ("touches migrations — 2 open PRs") in a follow-up PR.

---

## Constraints

- Additive; no hard serialization of all work (§7a serializes only opted-in surfaces).
- Race-safe: `change_intents` uses optimistic inserts; `last_migration_number` uses atomic UPDATE.
- The `sequenceNamespace` anchor-injection is the primary migration-conflict fix; the reservation API is a secondary backstop.

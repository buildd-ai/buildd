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

### 8. Announcement surface (future)

Intent rows are queryable via `GET /api/workspaces/[id]/change-intents?open=true`. The mission timeline can surface a badge ("touches migrations — 2 open PRs") in a follow-up PR.

---

## Constraints

- Additive; no hard serialization of all work.
- Race-safe: `change_intents` uses optimistic inserts; `last_migration_number` uses atomic UPDATE.
- The `sequenceNamespace` anchor-injection is the primary migration-conflict fix; the reservation API is a secondary backstop.

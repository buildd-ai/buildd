# Friction Task Dedup + Manifest Inference

**Status:** Proposed
**Related:**
- `apps/runner/src/error-trace-scanner.ts` — pattern definitions and `ErrorTrace` type
- `packages/core/path-overlap.ts` — `pathsOverlap`, `findBlockingPr`
- `apps/web/src/app/api/tasks/route.ts` — `POST /api/tasks` (task creation + auto-dependsOn)
- `apps/web/src/app/api/workers/claim/route.ts` — claim gate, `findBlockingPr` call
- `apps/web/src/app/api/workers/claim/deps-gate.ts` — `dependenciesSatisfied()` SQL
- `apps/web/src/app/api/workers/[id]/route.ts` — `appendErrorTraces` write path
- `packages/core/mcp-tools.ts:1084` — MCP `create_task` handler
- `CLAUDE.md` — friction-filing instructions agents receive

---

## Problem

Three workers hit `bwrap: No permissions to create a new namespace` simultaneously. Each filed a separate `[friction] bwrap namespace denied` task. Three branches opened; two were closed as duplicates (PRs #1350, #1367, #1371). The bwrap fix was landed once; the other two workers' branches were wasted.

Two structural gaps caused this:

1. **No dedup at filing time.** `POST /api/tasks` treats every friction task as a fresh create. N concurrent workers → N identical tasks, regardless of whether the underlying problem is the same.

2. **No pathManifest on friction tasks.** Because agents don't know which source files a friction fix will touch, they omit `pathManifest`. The overlap machinery in `path-overlap.ts` and the claim-route backstop (`findBlockingPr`) are both no-ops for tasks without a manifest — so even if dedup were added, the sibling tasks would race for the same files.

Repro: mission e00c5c32, task ac8c7764, PRs #1350/#1367/#1371.

---

## Current State

### How friction tasks are filed today

An agent calls `buildd` MCP `create_task` with:
```
title: "[friction] bwrap namespace denied"
description: "bwrap: No permissions to create a new namespace — all Bash calls fail"
```

This reaches `POST /api/tasks` (apps/web/src/app/api/tasks/route.ts:146). No dedup check exists. A row is inserted unconditionally; the response is a new task object.

### Where error-trace patterns live

`apps/runner/src/error-trace-scanner.ts` defines `PATTERNS` — an array of `{ slug, re }` objects. The scanner runs against every agent tool result. Matches become `ErrorTrace` objects (`{ pattern, excerpt, source }`) buffered on the worker and written to `worker_error_traces` via `appendErrorTraces` on the next PATCH to `PATCH /api/workers/[id]`.

`worker_error_traces` columns:
- `workerId`, `taskId` — FK to the worker/task that produced the trace
- `pattern` — slug from PATTERNS (e.g. `bwrap_namespace_denied`)
- `excerpt` — raw line, ≤500 chars
- `source` — tool name (e.g. `bash`)
- `ts` — timestamp

The `pattern` slug is **deterministic and shared across all workers** that hit the same class of error. It is the correct match key for dedup.

### How path-overlap machinery works today

`pathsOverlap(a, b)` in `packages/core/path-overlap.ts` does exact + prefix matching on two path arrays. It is called in two places:

1. **Task creation** (`apps/web/src/app/api/tasks/route.ts:282–305`): scans `tasks` with `status IN ('pending','assigned','in_progress')` and `pathManifest IS NOT NULL`, auto-adds `dependsOn` edges for any overlap.

2. **Claim route** (`apps/web/src/app/api/workers/claim/route.ts:589–601`): calls `findBlockingPr(taskManifest, openPrTasks)` — compares the candidate task's `pathManifest` against workers that have an open PR (`prUrl IS NOT NULL AND mergedAt IS NULL`). The open PR workers' manifests come from their associated `tasks.pathManifest`, not from the GitHub changed-files API.

Both mechanisms are **no-ops when `pathManifest` is null**, which is the current state for all friction tasks.

### Where PR changed files are stored

PR changed files are **not stored** on workers or tasks. The `changedFiles` column in `knowledgeIngestJobs` is unrelated (tracks files ingested into the knowledge base). The claim route's `findBlockingPr` relies exclusively on `tasks.pathManifest` — not on GitHub's `/pulls/:number/files` API. The reviewer path (`apps/web/src/app/api/github/webhook/route.ts:917`) calls that API for escalation decisions, but that data is not persisted.

### The dependsOn gate and PR-close hazard

`dependenciesSatisfied()` in `apps/web/src/app/api/workers/claim/deps-gate.ts` unblocks a dependent when every upstream dep is `completed` or `cancelled`. A `completed` dep with an open/unmerged PR still blocks (guards against the PRs #1044–1049 burst).

**Current gap**: If an upstream PR is *closed without merging*, `mergedAt IS NULL` and `prLifecycleStatus = 'closed'`. The dep-gate treats it as an open PR and blocks downstream tasks forever. The GitHub webhook sets `prLifecycleStatus: 'closed'` on the worker row but does not cancel the task, so the `cancelled`-unblocking path is never taken.

---

## Proposal

### Crux

The match key for friction dedup is `(frictionSignature, workspaceId)` — the pattern slug plus workspace. This is exact, deterministic, and scoped. Fuzzy title matching would break on phrasing variation; full-title matching would miss slight wording differences across agents.

---

### 1. Dedup Gate

**New context field on friction tasks**: `frictionSignature: string`

An agent filing a friction task must pass the error-pattern slug in `context.frictionSignature`. The agent obtains the slug by calling `get_error_traces` (available via MCP) before filing; the trace row carries the `pattern` field directly.

**Instruction change in CLAUDE.md** (under "Issues & Friction"):
```
When filing a friction task for a traced error, call get_error_traces first to get the
pattern slug (e.g. 'bwrap_namespace_denied'), then include it in the create_task call:
  context: { frictionSignature: '<slug>', frictionExcerpt: '<first line of excerpt>' }
```

**Dedup check in `POST /api/tasks`** (after workspace validation, before `db.insert`):

```typescript
// Dedup gate for friction tasks
const signature = typeof incomingContext?.frictionSignature === 'string'
  ? incomingContext.frictionSignature
  : null;

if (title.startsWith('[friction] ') && signature) {
  const existing = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.workspaceId, workspaceId),
      like(tasks.title, '[friction] %'),
      sql`${tasks.context}->>'frictionSignature' = ${signature}`,
      notInArray(tasks.status, ['completed', 'failed', 'cancelled']),
    ),
    columns: { id: true, title: true, description: true },
  });

  if (existing) {
    // Append this worker's report to the existing task description
    const workerRef = createdByWorkerId ? `Worker ${createdByWorkerId}` : 'Another worker';
    const appendText = `\n\n---\n_${workerRef} also reported this error._\n${description || ''}`.trim();
    await db.update(tasks)
      .set({ description: sql`${tasks.description} || ${appendText}`, updatedAt: new Date() })
      .where(eq(tasks.id, existing.id));

    return NextResponse.json({ ...existing, deduplicated: true }, { status: 200 });
  }
}
```

**MCP response** (in `mcp-tools.ts` `create_task` case): When the API returns `deduplicated: true`, format the response as:
```
Friction task already open: "<title>" (ID: <id>)
Your report has been appended. Follow progress with get_task (taskId <id>).
```
instead of the normal "Task created" text.

**Match semantics**:
- `signature` = exact pattern slug (e.g. `bwrap_namespace_denied`)
- Scope = workspace (not global — the same pattern on different workspaces files independently)
- Open window = `status NOT IN ('completed', 'failed', 'cancelled')` — a resolved friction task can be re-opened by a new occurrence

**Miss behavior**: If no open match exists, create normally and stamp `context.frictionSignature = signature` and `context.frictionExcerpt = excerpt` on the new task.

---

### 2. Manifest Inference for Friction Tasks

**New pure function**: `inferFrictionManifest(pattern: string, excerpt: string): string[]`

Location: `packages/core/path-overlap.ts` (alongside `pathsOverlap`).

**Algorithm**:

Step 1 — extract paths from excerpt. Try to find absolute or repo-relative file paths in the excerpt text using a simple regex:
```typescript
// Match /absolute/paths/ending-in-extension or relative paths starting with apps|packages
const PATH_RE = /(?:\/[\w./-]+\.\w+|(?:apps|packages)\/[\w./-]+\.\w+)/g;
```
Normalize absolute paths by stripping everything up to and including the first occurrence of a known repo-root marker (`/apps/`, `/packages/`). Return the normalized paths if any are found.

Step 2 — if no paths in excerpt, look up the pattern in the component table:

```typescript
const PATTERN_COMPONENT_MAP: Record<string, string[]> = {
  bwrap_namespace_denied: [
    'apps/runner/src/env-scan.ts',
    'apps/runner/src/workers.ts',
  ],
  oom_killed: ['apps/runner/src/workers.ts'],
  git_fatal:   ['apps/runner/src/git-operations.ts'],
  git_error:   ['apps/runner/src/git-operations.ts'],
  enoent:      [],   // path usually in excerpt; fallback is empty
  permission_denied: [],
  cd_no_such_file: [],  // path in excerpt
  no_such_file:    [],  // path in excerpt
  command_not_found: [],
  rate_limit:        [],
  connection_refused: [],
  timeout:           [],
};
```

Step 3 — return `PATTERN_COMPONENT_MAP[pattern] ?? []`.

**Wiring into `POST /api/tasks`**:

After the dedup check, when creating a new friction task (miss path):

```typescript
if (title.startsWith('[friction] ') && signature && !pathManifest) {
  const excerpt = typeof incomingContext?.frictionExcerpt === 'string'
    ? incomingContext.frictionExcerpt
    : description || '';
  const inferred = inferFrictionManifest(signature, excerpt);
  if (inferred.length > 0) {
    // Feed into the existing overlap machinery unchanged
    pathManifest = inferred;  // reassign before the auto-dependsOn block
  }
}
```

The inferred `pathManifest` then flows into the existing auto-dependsOn logic at line 287 and is persisted on the task row normally. No changes to `path-overlap.ts` or the claim route are needed — the existing `findBlockingPr` call and `dependenciesSatisfied()` gate handle serialization automatically once the manifest is present.

---

### 3. Overlap-Aware Branching

**Decision table** for when the new friction task's inferred `pathManifest` overlaps open PR tasks in the same workspace.

The overlap check runs at task creation time against `tasks.pathManifest` of in-flight tasks (existing code, `tasks/route.ts:287–305`). This produces a `dependsOn` edge automatically. At claim time, `findBlockingPr` provides a second guard.

The question is whether to also set `baseBranch = <pr-branch>` so the friction fix can be stacked on top of the blocking PR.

| Scenario | Action |
|---|---|
| No manifest overlap with any open PR | Create normally; no baseBranch, no extra dependsOn |
| Manifest overlaps an open PR task's manifest | Auto-dependsOn edge added by existing machinery; **no baseBranch** — friction fix lands on default branch after the PR merges |
| Manifest overlaps but agent explicitly requests `baseBranch` in context | Honor as-is (current behaviour) |

**Why not baseBranch-on-PR-branch for friction tasks?** A friction task is a platform fix, not a feature that depends on another PR's code. Branching from a peer PR introduces a cascade: if the base PR's review changes the files, the friction branch must rebase. The simpler path is `dependsOn` — wait for the PR to merge, then the friction fix lands cleanly on the default branch.

**Exception** (out of scope for this design, but noted): If the friction task is a fix to code introduced by the specific PR it's overlapping with (e.g. a reviewer task branching from the original task's branch), `baseBranch` is appropriate. The agent would detect this case and pass `baseBranch` explicitly. No server-side inference needed.

#### Rebase hazard: upstream PR closes without merging

**Scenario**: Friction task A has `dependsOn = [task-B]`. Task B's PR is closed (not merged). `mergedAt IS NULL`, `prLifecycleStatus = 'closed'`. Task B's status remains `completed`. The `deps-gate.ts` open-PR guard fires: `prUrl IS NOT NULL AND mergedAt IS NULL` → task A is blocked forever.

**Fix**: Add `prLifecycleStatus != 'closed'` to the open-PR guard in `dependenciesSatisfied()`:

```typescript
// In deps-gate.ts, inside the EXISTS sub-query:
AND NOT (
  t2.status = 'completed'
  AND EXISTS (
    SELECT 1 FROM workers w
    WHERE w.task_id = t2.id
    AND w.pr_url IS NOT NULL
    AND w.merged_at IS NULL
    AND COALESCE(w.pr_lifecycle_status, '') != 'closed'  -- ← add this
  )
)
```

This ensures a closed PR (abandoned, not merged) unblocks its dependents. The GitHub webhook already sets `prLifecycleStatus = 'closed'` on the PR close event — no webhook changes needed.

---

## Acceptance Criteria

Replaying the bwrap incident (three workers, same pattern, same workspace):

1. **Worker A** calls `get_error_traces`, receives `{ pattern: 'bwrap_namespace_denied', excerpt: '...' }`. Calls `create_task` with `title: '[friction] bwrap namespace denied'`, `context: { frictionSignature: 'bwrap_namespace_denied', frictionExcerpt: '...' }`. Task created (ID: T1). `T1.pathManifest = ['apps/runner/src/env-scan.ts', 'apps/runner/src/workers.ts']`. `T1.context.frictionSignature = 'bwrap_namespace_denied'`.

2. **Worker B** (concurrent) does the same. `POST /api/tasks` dedup check fires: finds T1 (open, same signature, same workspace). Appends B's context to T1.description. Returns `{ id: T1.id, deduplicated: true }`. **No second task created.**

3. **Worker C** (later) does the same. Dedup fires again → appends to T1. **Still one task.**

4. **Task T1** is claimed. The runner branches from `origin/dev`. The worker fixes `env-scan.ts` and `workers.ts`. PR #NXXX is opened. Single branch lineage, one review.

5. **If an overlapping task T0 is in flight** (e.g., another PR touching `env-scan.ts`) when T1 is created: `resolvedDependsOn` includes T0.id. T1 waits. If T0's PR merges → `mergedAt` set → T1 unblocks. If T0's PR is closed without merge → `prLifecycleStatus = 'closed'` → `deps-gate.ts` with the fix unblocks T1.

---

## Open Questions

1. **Should dedup append to description or fire a missionNotes event?** Appending to description is immediate but makes the field noisier. A `missionNotes` row would be structurally cleaner but requires joining an extra table. Lean toward description append (simpler, visible in the task detail view today).

2. **Should `frictionExcerpt` be a required field or inferred from description?** Requiring it gives better path extraction but adds friction to the filing flow (pun intended). Lean toward inferring from description if `frictionExcerpt` is absent — the fallback component table is good enough for the known patterns.

3. **Should `inferFrictionManifest` live in `path-overlap.ts` or a new `friction-manifest.ts`?** The function depends on `error-trace-scanner.ts`'s slug names, which `path-overlap.ts` doesn't currently import. A new module avoids circular imports. Lean toward `packages/core/friction-manifest.ts`.

4. **PR-close unblock fix scope**: The `deps-gate.ts` fix for closed PRs applies globally (not just friction tasks). It's strictly correct behavior — a closed PR should never permanently block a downstream task. No objection to landing it broadly.

---

## Non-Goals

- Server-side auto-detection of friction patterns without agent involvement. Agents file friction tasks explicitly; this design improves that flow, not replaces it.
- Storing GitHub PR changed files on the workers/tasks table for use in overlap detection. The existing `tasks.pathManifest` approach is cheaper and sufficient for the known patterns.
- Merging duplicate friction tasks retroactively. The dedup gate is forward-looking only; existing duplicates are not collapsed.
- Inferring `baseBranch` server-side from PR overlap. Agents that need stacked branches pass `baseBranch` explicitly.

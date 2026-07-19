# Retry Continuity Design Spec

> **Status:** draft — awaiting approval before implementation begins.
>
> **Scope:** End-to-end design for preserving prior-attempt git work across all
> retry paths — auto-requeue, CI retry (`ci-retry.ts`), and reviewer-loop retry
> — so that a second agent attempt can assess and continue from the first
> attempt's commits rather than always starting from `defaultBranch`.
>
> **Sources of truth read before this doc:**
> - `apps/web/src/app/api/workers/[id]/route.ts` — worker status transitions
>   (lines 590–613: auto-retry; lines 1292–1315: reviewer-loop retry)
> - `apps/web/src/lib/ci-retry.ts` — CI retry task builder
> - `apps/runner/src/worktree-utils.ts` — `resolveWorktreeBase()` (current impl)
> - `packages/shared/src/types.ts` — `Task`, `Worker`, `TaskResult`
> - `packages/core/db/schema.ts` — `tasks` (context jsonb), `workers` (branch,
>   lastCommitSha fields)

---

## Background & Motivation

When a task fails, buildd currently has three retry paths:

1. **Auto-requeue** (mission tasks) — the same task flips back to `pending` with
   `context.retryCount` incremented.
2. **CI retry** — a new task is created from the failing PR's check_suite webhook
   with `context.baseBranch = worker.branch` so the next agent starts from the
   PR branch.
3. **Reviewer-loop retry** — a new task is created when a reviewer requests
   changes, also setting `context.baseBranch = workerBranch`.

All three paths make the *branch* available to the next agent via `baseBranch`,
but none record:
- The **last commit SHA** on that branch (needed to assess divergence and anchor
  a git log diff).
- A **structured failure summary** the agent can parse (today `failureContext` is
  a free-text string in CI retry, and `output.feedback` in reviewer retry — no
  common shape).

Without `lastCommitSha`, an agent that wants to inspect "what did the prior
attempt do?" cannot reliably anchor a `git log --oneline <sha>..HEAD` or a
`git diff <sha>` without first digging through the remote branch history. Without
a structured `failureContext`, the salvage decision relies on the agent parsing
unstructured error prose.

This spec adds:
- `context.resumeBranch` and `context.lastCommitSha` to carry the prior
  attempt's work coordinates.
- A typed `FailureContext` object replacing bare strings.
- A new branch-selection code path in `resolveWorktreeBase()` that fetches
  `resumeBranch` and falls back gracefully.
- A system-prompt injection that directs the agent to assess prior work before
  touching files.

---

## 1. Data Model

No DB schema migration is required. All new fields live in `tasks.context`
(jsonb, existing column). This matches the pattern already used for `retryCount`,
`baseBranch`, `iteration`, `maxIterations`, and `failureContext` (string) today.

### 1.1 TypeScript types to add to `packages/shared/src/types.ts`

```typescript
/**
 * Structured description of why a prior attempt failed.
 * Stored in task.context.failureContext and forwarded to retry tasks.
 */
export interface RetryFailureContext {
  /** Human-readable summary of the failure (CI log excerpt, reviewer feedback, error message). */
  summary: string;
  /** Broad category for programmatic routing. */
  errorType?: 'ci_failure' | 'reviewer_request_changes' | 'runtime_error' | 'timeout' | 'budget_exhausted';
  /** SHA of the last commit on the prior attempt's branch (same as context.lastCommitSha). */
  commitSha?: string;
}

/**
 * Retry-continuity fields stored in task.context.
 * All fields are optional — absent = first attempt with no prior work.
 */
export interface TaskRetryContext {
  /** Branch name from the prior attempt (e.g. "buildd/abc123-fix-login-flow"). */
  resumeBranch?: string;
  /** SHA of the last commit on resumeBranch, captured at failure time. */
  lastCommitSha?: string;
  /** Structured failure context from the prior attempt. */
  failureContext?: RetryFailureContext | string; // string for backward compat with existing tasks
}
```

> **Backward compat note:** `failureContext` today is a `string` in CI retry
> tasks and reviewer-loop tasks. The union type (`RetryFailureContext | string`)
> preserves runtime compatibility — consumers must `typeof ctx.failureContext ===
> 'string'` before treating it as structured. New code always writes the object
> form. The prompt injection section (§5) handles both forms.

### 1.2 Context key inventory (all retry-related keys in `task.context`)

| Key | Type | Who writes it | Meaning |
|-----|------|---------------|---------|
| `retryCount` | `number` | auto-requeue path (route.ts:600) | auto-retry attempt counter |
| `baseBranch` | `string` | CI retry + reviewer retry | branch to start new worktree from |
| `resumeBranch` | `string` | **NEW** — failure capture (§2) | same as baseBranch but for first-class continuity tracking |
| `lastCommitSha` | `string` | **NEW** — failure capture (§2) | last commit SHA on resumeBranch |
| `failureContext` | `RetryFailureContext \| string` | CI retry (string today → object going forward) | structured failure info |
| `iteration` | `number` | CI retry + reviewer retry | attempt number (1-based) |
| `maxIterations` | `number` | CI retry + reviewer retry | cap before escalation |

---

## 2. Failure Capture

**File:** `apps/web/src/app/api/workers/[id]/route.ts`  
**Where:** The `status === 'failed'` block (lines 590–613).

When a worker's status transitions to `failed`, before the task is either
re-queued (auto-retry) or permanently marked failed, write
`context.resumeBranch` and `context.lastCommitSha` from the worker record.

### 2.1 Current code (lines 589–613, simplified)

```typescript
if (status === 'failed') {
  const taskForRetry = await db.query.tasks.findFirst({ ... });
  taskCtxForRetry = (taskForRetry?.context || {}) as Record<string, unknown>;
  const retryCount = (taskCtxForRetry.retryCount as number) || 0;
  const maxRetries = taskForRetry?.missionId ? 1 : 0;
  shouldAutoRetry = retryCount < maxRetries;
  if (shouldAutoRetry) {
    taskCtxForRetry = { ...taskCtxForRetry, retryCount: retryCount + 1 };
  }
}
```

### 2.2 Required change

After building `taskCtxForRetry`, inject `resumeBranch` and `lastCommitSha`
from the failing worker, and build a `failureContext` object:

```typescript
if (status === 'failed') {
  const taskForRetry = await db.query.tasks.findFirst({ ... });
  taskCtxForRetry = (taskForRetry?.context || {}) as Record<string, unknown>;
  const retryCount = (taskCtxForRetry.retryCount as number) || 0;
  const maxRetries = taskForRetry?.missionId ? 1 : 0;
  shouldAutoRetry = retryCount < maxRetries;
  if (shouldAutoRetry) {
    taskCtxForRetry = { ...taskCtxForRetry, retryCount: retryCount + 1 };
  }

  // NEW: capture branch coordinates from the failing worker
  if (worker.branch) {
    taskCtxForRetry = {
      ...taskCtxForRetry,
      resumeBranch: worker.branch,
      ...(worker.lastCommitSha ? { lastCommitSha: worker.lastCommitSha } : {}),
      failureContext: {
        summary: body.error ?? worker.error ?? 'Worker failed without an error message',
        errorType: 'runtime_error',
        ...(worker.lastCommitSha ? { commitSha: worker.lastCommitSha } : {}),
      },
    };
  }
}
```

Key invariants:
- This runs for **both** `shouldAutoRetry = true` and `shouldAutoRetry = false`.
  For the non-retry path (permanent failure), the context update is a no-op
  because the task never flips back to `pending` — but see §3.1 for why it is
  still written (CI retry and reviewer-loop retry read from the task record).
- `worker.branch` is always a non-empty string on the `workers` table (the
  column is `NOT NULL` and set at claim time).
- `worker.lastCommitSha` may be `null` if the agent never reported a commit (e.g.
  aborted on startup). The spread guard prevents writing `lastCommitSha: null`.

---

## 3. Retry Propagation

### 3.1 Auto-requeue (same task)

When `shouldAutoRetry = true`, the task context is updated in-place (line 611:
`context: taskCtxForRetry`) and the task flips to `pending`. Because
`resumeBranch`, `lastCommitSha`, and `failureContext` are written into
`taskCtxForRetry` (§2), they persist naturally with the task and will be
available to the next worker that claims it.

**Verification needed:** Confirm nothing in the claim path or `resolveWorktreeBase()` call (§4) wipes or overwrites `resumeBranch`/`lastCommitSha` after they are set. Specifically:
- `apps/web/src/app/api/workers/claim/route.ts` — must not reset task context fields on claim.
- `apps/runner/src/workers.ts` — the worker init path reads `task.context` but does not mutate it server-side.

### 3.2 CI retry task (`apps/web/src/lib/ci-retry.ts`)

`buildCIRetryTask()` already copies `baseBranch: worker.branch` into the child
task context (line 85). The upgrade:

1. Also copy `resumeBranch`, `lastCommitSha`, and the structured `failureContext`
   from the *parent task context* if present. The parent task has these fields
   written by §2 (the failure capture runs before the CI webhook fires, since the
   worker status is set to `failed` first, which triggers the check_suite event).

2. Replace the bare `failureContext: string` field with the structured object.
   Keep `baseBranch` as-is for backward compat with existing worktree logic.

**Required change to `buildCIRetryTask()`:**

```typescript
context: {
  baseBranch: worker.branch,           // existing — worktree starts from PR branch
  resumeBranch: worker.branch,         // NEW — same value; explicit continuity marker
  // Copy lastCommitSha from parent context if available (written by §2)
  ...(typeof ctx.lastCommitSha === 'string' ? { lastCommitSha: ctx.lastCommitSha } : {}),
  // Structured failure context (replaces bare failureContext string going forward)
  failureContext: {
    summary: failureContext,           // CI log excerpt (existing string param)
    errorType: 'ci_failure',
    ...(typeof ctx.lastCommitSha === 'string' ? { commitSha: ctx.lastCommitSha } : {}),
  },
  // ... rest of existing fields (iteration, maxIterations, ciRunId, etc.)
},
```

### 3.3 Reviewer-loop retry task (`route.ts` line ~1292)

The reviewer-loop already sets `baseBranch: workerBranch` in the new task's
context (line 1304). The upgrade copies `lastCommitSha` and builds a structured
`failureContext`:

```typescript
context: {
  iteration: currentIteration + 1,
  maxIterations,
  baseBranch: workerBranch,           // existing — continue on same PR branch
  resumeBranch: workerBranch,         // NEW — explicit continuity marker
  // Copy lastCommitSha from the worker directly (available in scope)
  ...(worker.lastCommitSha ? { lastCommitSha: worker.lastCommitSha } : {}),
  // Structured failure context
  failureContext: {
    summary: output.feedback ?? output.summary ?? 'Reviewer requested changes',
    errorType: 'reviewer_request_changes',
    ...(worker.lastCommitSha ? { commitSha: worker.lastCommitSha } : {}),
  },
  prNumber,
  prUrl,
  workerBranch,
},
```

> **Note:** In the reviewer-loop code the `worker` record for the previous
> attempt is available in scope (it is fetched earlier in the reviewer handler to
> read `worker.branch`). Accessing `worker.lastCommitSha` requires either
> including it in the existing `findFirst` query projection or adding it.

---

## 4. Runner Branch Selection

**File:** `apps/runner/src/worktree-utils.ts`  
**Function:** `resolveWorktreeBase(defaultBranch, context)`

### 4.1 Current implementation

```typescript
export function resolveWorktreeBase(
  defaultBranch: string,
  context: Record<string, unknown> | undefined | null,
): string {
  const baseBranch = context?.baseBranch;
  if (baseBranch && typeof baseBranch === 'string' && baseBranch.length > 0) {
    return `origin/${baseBranch}`;
  }
  return `origin/${defaultBranch}`;
}
```

This function returns a git ref string only. Actual `git fetch` and `git
worktree add` calls are the caller's responsibility.

### 4.2 Required change

`resolveWorktreeBase()` must be upgraded to:
1. Prefer `context.resumeBranch` over `context.baseBranch` (both serve the same
   purpose; `resumeBranch` is the canonical new name while `baseBranch` is kept
   for existing CI retry tasks during the rollout window).
2. Accept an async `branchExists` probe so the caller can verify the remote
   branch before returning it, with a fallback to `defaultBranch`.
3. Apply a divergence guard: if the branch is >50 commits ahead of base AND has
   a merged/closed PR, log a warning and fall back to `defaultBranch`.

#### New signature

```typescript
export type BranchFetchResult = 'ok' | 'missing' | 'diverged';

export interface ResolveWorktreeBaseOptions {
  defaultBranch: string;
  context: Record<string, unknown> | undefined | null;
  /** Async probe: fetch the named branch from origin and return its status. */
  fetchBranch?: (branch: string) => Promise<BranchFetchResult>;
  /** If provided, log messages about fallbacks. */
  log?: (msg: string) => void;
}

export async function resolveWorktreeBase(
  opts: ResolveWorktreeBaseOptions,
): Promise<string> {
  const { defaultBranch, context, fetchBranch, log } = opts;

  // Prefer resumeBranch (new canonical field) over baseBranch (legacy CI retry field)
  const candidate =
    (context?.resumeBranch as string | undefined) ||
    (context?.baseBranch as string | undefined);

  if (!candidate || typeof candidate !== 'string' || candidate.length === 0) {
    return `origin/${defaultBranch}`;
  }

  if (!fetchBranch) {
    // No probe available — return optimistically (backward-compat for callers
    // that haven't wired up the probe yet)
    return `origin/${candidate}`;
  }

  const result = await fetchBranch(candidate);
  if (result === 'missing') {
    log?.(`[worktree] resumeBranch ${candidate} not found on remote — falling back to ${defaultBranch}`);
    return `origin/${defaultBranch}`;
  }
  if (result === 'diverged') {
    log?.(`[worktree] resumeBranch ${candidate} is diverged beyond recovery — falling back to ${defaultBranch}`);
    return `origin/${defaultBranch}`;
  }

  return `origin/${candidate}`;
}
```

#### Divergence guard logic (inside `fetchBranch` implementation, not inside `resolveWorktreeBase`)

The `fetchBranch` callback is implemented in `apps/runner/src/workers.ts` (the
caller that performs actual git operations). It runs:

```bash
# 1. fetch the branch
git fetch origin <candidate>

# 2. check commit distance from base
git rev-list --count origin/<defaultBranch>..origin/<candidate>
```

If the count exceeds 50 **and** the GitHub PR for this branch has status
`merged` or `closed`, return `'diverged'` and the function falls back. The
runner should also emit an `update_progress` note via the MCP tool:

```
Prior work branch '<candidate>' is diverged (>50 commits ahead of base, PR merged/closed). Starting from '<defaultBranch>' instead.
```

If the count exceeds 50 but the PR is still open (active work), treat as `'ok'`
— the branch is valid and the agent should continue from it.

#### Backward compatibility

The existing synchronous `resolveWorktreeBase(defaultBranch, context)` signature
is changed to async. All callers must be updated to `await` the result. The
worktree tests in `apps/runner/__tests__/unit/worktree-utils.test.ts` must be
updated to pass mock `fetchBranch` callbacks.

---

## 5. Salvage-vs-Restart Prompt

When `context.resumeBranch` is set on the claimed task, the runner injects an
additional section into the worker system prompt instructing the agent to assess
the prior work before touching files.

**File:** `apps/runner/src/workers.ts`  
**Where:** Near line 1727–1734 where `systemPrompt.append` is constructed.

### 5.1 Injection logic

```typescript
// Build retry-continuity prompt section if resumeBranch is set
const resumeBranch = (task.context as any)?.resumeBranch as string | undefined;
const lastCommitSha = (task.context as any)?.lastCommitSha as string | undefined;
const rawFailureCtx = (task.context as any)?.failureContext;
const failureSummary: string | undefined =
  typeof rawFailureCtx === 'string'
    ? rawFailureCtx
    : (rawFailureCtx as any)?.summary;

if (resumeBranch) {
  const base = defaultBranch; // resolved from workspace config
  const sha = lastCommitSha ?? `origin/${resumeBranch}`;
  const retryContinuitySection = [
    '',
    '## Prior Attempt — Assess Before Starting',
    '',
    'A previous agent attempt left commits on this branch. Before editing any file:',
    '',
    `1. Run \`git log --oneline origin/${resumeBranch}..HEAD\` to see what this attempt has already done.`,
    `   (If the worktree is already on \`${resumeBranch}\`, run \`git log --oneline ${sha}~1..HEAD\` instead.)`,
    `2. Run \`git diff origin/${base}...origin/${resumeBranch}\` to see what the prior attempt changed relative to base.`,
    ...(failureSummary ? [
      `3. The prior attempt failed with: ${failureSummary}`,
    ] : []),
    `${failureSummary ? '4' : '3'}. Explicitly decide: **continue/salvage** (fix what failed, keep prior commits) or **restart** (reset to base, start clean).`,
    `${failureSummary ? '5' : '4'}. Log your decision via \`update_progress\` **before** making any file edits.`,
    '',
    'Do not skip this assessment step. The decision and its rationale must appear in the progress log.',
  ].join('\n');

  // Append to existing systemPrompt.append (skill instruction may already be there)
  systemPrompt.append = (systemPrompt.append ?? '') + retryContinuitySection;
}
```

### 5.2 Decision log format (what the agent should emit)

The agent is free to phrase the decision naturally but must call `update_progress`
with a message that includes one of: `"continue"`, `"salvage"`, or `"restart"`,
and a brief rationale. Example:

> Decision: **salvage** — Prior attempt fixed the import error but left the tests
> broken at `src/foo.test.ts:42`. Continuing from commit `a3f9b12`.

---

## 6. Test Requirements

### 6.1 Unit tests (`apps/runner/__tests__/unit/worktree-utils.test.ts`)

The existing unit tests for `resolveWorktreeBase` must be updated for the new
async signature and extended to cover:

| Test case | Input | Expected output |
|-----------|-------|-----------------|
| No context | `context: null` | `origin/<defaultBranch>` |
| `baseBranch` only (legacy CI retry) | `context: { baseBranch: 'buildd/abc' }` | `origin/buildd/abc` |
| `resumeBranch` takes precedence over `baseBranch` | `context: { resumeBranch: 'buildd/abc', baseBranch: 'buildd/old' }` | `origin/buildd/abc` |
| Remote branch missing (`fetchBranch` returns `'missing'`) | `resumeBranch: 'buildd/abc'`, fetchBranch → `'missing'` | `origin/<defaultBranch>` |
| Remote branch diverged (`fetchBranch` returns `'diverged'`) | `resumeBranch: 'buildd/abc'`, fetchBranch → `'diverged'` | `origin/<defaultBranch>` |
| No `fetchBranch` probe (backward compat) | `resumeBranch` set, no probe | `origin/<resumeBranch>` (optimistic) |

### 6.2 Route handler tests (`apps/web/src/app/api/workers/[id]/route.test.ts`)

Assert that when a worker transitions to `failed`:
- `task.context.resumeBranch` equals `worker.branch`
- `task.context.lastCommitSha` equals `worker.lastCommitSha` (when set)
- `task.context.failureContext` is an object `{ summary: string, errorType: 'runtime_error' }`
- For auto-requeue tasks: the above fields are present alongside `retryCount: 1`

### 6.3 CI retry tests (`apps/web/src/lib/ci-retry.test.ts` or similar)

Assert that `buildCIRetryTask()`:
- Sets `context.resumeBranch = worker.branch`
- Sets `context.failureContext` as a `RetryFailureContext` object (not a bare string)
- Copies `context.lastCommitSha` from the parent task context when present
- Still sets `context.baseBranch = worker.branch` (unchanged, for backward compat)

### 6.4 Integration / E2E assertion (conceptual)

An integration test simulating two task attempts should verify:
- The second attempt's worker receives a task whose `context.resumeBranch`
  matches the first attempt's worker's `branch` field.
- The second attempt's `resolveWorktreeBase()` call returns
  `origin/<resumeBranch>` (not `origin/<defaultBranch>`), confirmed by
  inspecting the worktree setup log.
- When the first attempt's branch is deleted between attempts, `resolveWorktreeBase()`
  returns `origin/<defaultBranch>` (fallback fires correctly).

---

## 7. Migration & Rollout Notes

- **No DB migration.** All new fields are jsonb keys — additive, no schema change.
- **No breaking change to the `resolveWorktreeBase` callers in tests** — the
  function signature changes to async but returns the same logical value. Update
  all call sites to `await` before merging.
- **Backward compat for existing retry tasks** — tasks created before this
  feature ships may have `baseBranch` but not `resumeBranch`. The updated
  `resolveWorktreeBase()` checks `resumeBranch ?? baseBranch`, so they degrade
  gracefully.
- **`failureContext` string → object migration** — tasks created before this
  feature have `failureContext: string`. The prompt injection code (§5) handles
  both forms with a `typeof` guard. No backfill needed.
- **Rollout order:** §2 (failure capture) → §3 (retry propagation) → §4 (runner
  branch selection) → §5 (prompt injection). Each section is independently
  shippable; the continuity benefit accumulates with each addition.

# Review Gate UX — Design Spec

> **Status:** Proposed — awaiting Max's approval before any implementation begins.
> **Context:** PR #1120 (spec generic MCP connector system) was merged. Eight dependent build tasks sat
> silently as `pending`; "Start Task" no-oped with no explanation. The user had no signal that merging
> the PR was the required unblock. This spec closes that gap entirely.

---

## Problem Statement

Today, when a task completes with an unmerged PR and has dependent tasks:

- Dependent tasks show as `pending` — indistinguishable from tasks simply waiting for a runner.
- "Start Task" silently no-ops. The claim route enforces `pr_url IS NOT NULL AND merged_at IS NULL`
  as a gate, but that gate is invisible to the user.
- No notification fires when the gate opens (PR ready, dependents waiting).
- `checkDependsOnResolved()` fires `TASK_UNBLOCKED` and dispatches runners at task-completion time —
  before the PR is merged — so runners attempt to claim and fail the gate silently on every poll cycle.
- The mission view shows no indication that the phase boundary is a human-approval gate.

---

## Review Gate — Definition

A **review gate** is a task whose terminal state produced an unmerged PR AND which has at least one
dependent task whose `dependsOn` array includes that task's ID.

```
gate condition: task.status === 'completed'
             && worker.prUrl IS NOT NULL
             && worker.mergedAt IS NULL
             && EXISTS (SELECT 1 FROM tasks t2 WHERE t2.depends_on @> [task.id] AND t2.status = 'pending')
```

Gate resolves when the PR is merged (webhook sets `workers.mergedAt`) AND the branch is deleted
(matches the existing "done = merged-and-branch-deleted" doctrine). In practice, branch deletion is
handled by GitHub repo settings; the platform treats `mergedAt IS NOT NULL` as the authoritative
resolved signal.

### Gate lifecycle states

| State | Meaning |
|---|---|
| `pending` (normal) | No upstream PR gate — waiting for a runner |
| `blocked:gate` | Upstream task has open PR; this task will not be claimed until it merges |
| `queued` | All dependencies resolved; runner dispatch fired; awaiting claim |
| `running` / `waiting_input` / `completed` / `failed` | Standard task states |

The `blocked:gate` state is a display-level label derived from the existing schema — no new DB column
required. The claim route's existing `pr_url IS NOT NULL AND merged_at IS NULL` guard defines it.

---

## Spec

### 1. 'Waiting on You' Surface — Home + Activity

#### 1.1 New section on the Home page

Add a **"Waiting on you"** section above "Right Now" in `apps/web/src/app/app/(protected)/home/page.tsx`.

The section renders when at least one review gate is open for any workspace visible to the user.

**Query** — fetch open review gates (server component, cached short TTL ~10s):

```sql
SELECT DISTINCT ON (w.pr_number)
  t.id          AS task_id,
  t.title       AS task_title,
  t.workspace_id,
  ws.name       AS workspace_name,
  w.pr_url,
  w.pr_number,
  w.head_sha,
  COUNT(t2.id)  AS blocked_count,
  -- diff stats fetched separately from GitHub or cached on worker row
  w.lines_added,
  w.lines_removed,
  w.files_changed
FROM tasks t
JOIN workers w ON w.task_id = t.id
JOIN workspaces ws ON ws.id = t.workspace_id
JOIN tasks t2 ON t2.depends_on @> json_build_array(t.id::text)::jsonb
             AND t2.status = 'pending'
WHERE t.status = 'completed'
  AND w.pr_url IS NOT NULL
  AND w.merged_at IS NULL
GROUP BY t.id, t.title, t.workspace_id, ws.name, w.pr_url, w.pr_number, w.head_sha, w.lines_added, w.lines_removed, w.files_changed
ORDER BY w.pr_number DESC
LIMIT 20
```

**Row layout** (each open gate):

```
┌─────────────────────────────────────────────────────────────────────┐
│  [●] PR #1120 — spec generic MCP connector system         buildd    │
│      +847 −12 · 6 files · 8 tasks waiting                          │
│                                          [Review PR ↗]  [Merge]    │
└─────────────────────────────────────────────────────────────────────┘
```

Fields:
- **PR title + number** from `workers.prUrl` / `workers.prNumber`
- **Diff stats**: `+{linesAdded} −{linesRemoved} · {filesChanged} files` — from `workers` row
  (populated by `create_pr` action; cache from GitHub API if null)
- **workspace name** as a muted badge
- **`N tasks waiting`** count of dependent pending tasks
- **[Review PR ↗]** — deep link to `worker.prUrl` (GitHub PR page), opens in new tab
- **[Merge]** — calls the buildd-native merge endpoint (see §5)

Section header copy: **"Waiting on you"** with a count badge (e.g. "2 PRs").

Empty state: section is omitted entirely when no gates are open.

#### 1.2 Activity feed badge

In the Activity right-rail (recent completed workers), rows with `prUrl IS NOT NULL AND mergedAt IS NULL`
display a yellow **"Unmerged"** pill instead of the standard "completed" green dot, with a
**[Review]** micro-link inline.

---

### 2. Blocked-Task Page Banner

#### 2.1 Status label change

On the task detail page (`apps/web/src/app/app/(protected)/tasks/[id]/`) and in sidebar task lists,
dependent tasks whose `dependsOn` contains an unresolved gate display status **`blocked`** instead
of `pending`.

Computing `blocked:gate` client-side: when loading a task, the task API response should include a
derived field `blockingGate?: { taskId, prUrl, prNumber, taskTitle }` so the UI can render the label
without a separate query. Add this to the task summary endpoint (`/api/tasks/[id]/summary`).

#### 2.2 Banner copy

When `blockingGate` is present, render a yellow attention banner above the task body:

```
╔══════════════════════════════════════════════════════════════════════╗
║  Blocked by "spec generic MCP connector system" — PR #1120          ║
║  Merge the PR to start this task automatically.                     ║
║                                          [Review PR ↗]  [Merge]    ║
╚══════════════════════════════════════════════════════════════════════╝
```

The banner is informational + actionable. The **[Merge]** button calls the buildd-native merge endpoint
(§5). The **[Review PR ↗]** link opens GitHub.

#### 2.3 Start Task button — no silent no-op

The "Start Task" button must never silently no-op. Two acceptable behaviors:

- **Disabled with tooltip**: button is disabled when `blockingGate` is present; hovering shows:
  `"Blocked — merge PR #1120 first"`. Tooltip includes a [Review] link.
- **Click → gate sheet**: if the button is kept enabled, clicking it opens a bottom-sheet/modal
  explaining the gate with the merge CTA, rather than attempting claim.

Do NOT attempt to enqueue the task silently when a gate is unresolved.

---

### 3. Mission View — Phase Gate Chip

In the mission detail page (`apps/web/src/app/app/(protected)/missions/[id]/page.tsx`), between
task cycles where one cycle produced an unmerged PR that gates the next cycle's tasks, render a
**gate chip** in the execution spine.

**Gate chip layout:**

```
  ┊
  ● [Researcher cycle — completed]
  │
  ╔═══════════════════════════════════════════╗
  ║  ⏸  Awaiting your review — PR #1120 ↗    ║
  ║     Merge to continue  [Merge]            ║
  ╚═══════════════════════════════════════════╝
  │
  ● [Builder cycle — 8 tasks blocked]
  ┊
```

Detection: a gate chip renders between cycle N and cycle N+1 when:
- Cycle N contains at least one completed task with a worker that has `prUrl IS NOT NULL AND mergedAt IS NULL`
- Cycle N+1 contains at least one task whose `dependsOn` includes a cycle-N task ID

The chip is removed (and cycle N+1 renders normally) once the PR is merged.

---

### 4. Notification — PR Ready for Review

#### 4.1 Trigger

When a task transitions to `completed` and:
1. The task's latest worker has `prUrl IS NOT NULL`
2. The task has ≥1 pending dependent (via `dependsOn`)

Fire a **"review gate opened"** notification. This check lives in `resolveCompletedTask()` in
`apps/web/src/lib/task-dependencies.ts`, after the `checkDependsOnResolved()` call.

#### 4.2 Notification content

```
PR #1120 ready for review — 8 tasks waiting on merge
"spec generic MCP connector system"
[Review PR]
```

#### 4.3 Deduplication

Use the same pattern as `notifyMissionPrReady()` in `apps/web/src/lib/mission-notifications.ts`:
store the `headSha` of the last-notified PR per task on the worker row (or in `tasks.context`).
Re-notify only if:
- A new commit is pushed to the PR (new `headSha`), OR
- A new dependent task is added to `dependsOn` after the gate opened

Do NOT re-notify on every poll cycle.

#### 4.4 Notification path

1. **Pusher** event `task:review_gate_opened` on `channels.workspace(workspaceId)` — web dashboard picks
   up live.
2. **`notifyTeam()`** call → Pushover (existing per-team notification channel, purpose `'pushover'`).
   App: `'tasks'`, priority 0. Include PR URL in the message body.
3. **Optional — Pushover/cue bridge**: if the team has a `notify_webhook` secret configured, POST the
   same payload there. This is the existing webhook path; no new plumbing needed.

New Pusher event constant to add to `apps/web/src/lib/pusher.ts`:

```typescript
REVIEW_GATE_OPENED: 'task:review_gate_opened',
```

Payload:
```typescript
{
  taskId: string;       // the gating task
  prUrl: string;
  prNumber: number;
  prTitle: string;
  blockedCount: number; // count of pending dependents
  workspaceId: string;
}
```

---

### 5. Merge Endpoint + Auto-Start on Merge

#### 5.1 Buildd-native merge endpoint

Add a new route: `POST /api/prs/[prNumber]/merge`

Request body:
```typescript
{
  workspaceId: string;
  mergeMethod?: 'squash' | 'merge' | 'rebase';  // default: 'squash'
}
```

Implementation:
1. Look up `workers` row by `prNumber` + `workspaceId`.
2. Assert caller has access to the workspace.
3. Call `mergePullRequest(installationId, repoFullName, prNumber, mergeMethod)` from
   `apps/web/src/lib/github.ts` — this is the existing primitive; do NOT call GitHub directly from
   the frontend.
4. On success: immediately call `deleteRef(installationId, repoFullName, worker.branch)` to delete
   the source branch (matches "done = merged-and-branch-deleted" doctrine).
5. Set `workers.mergedAt = now` on the worker row (the webhook normally does this; set it here too
   in case the webhook races or is delayed).
6. Call `checkDependsOnResolved(task.id)` — see §5.3 for the corrected version.
7. Return `{ merged: true, branch: worker.branch, blockedTasksUnblocked: number }`.

**Provenance stamping**: set `workers.mergedBy = accountId` (new nullable column) so the audit trail
distinguishes agent auto-merge from user-initiated merge from this endpoint.

```sql
ALTER TABLE workers ADD COLUMN merged_by uuid REFERENCES accounts(id);
```

#### 5.2 Pre-merge expectation copy

Before the [Merge] button fires the endpoint, the UI shows inline copy:

> "Merging will automatically start 8 queued tasks."

This is rendered as a static label next to the button derived from `blockedCount`. No modal required.

#### 5.3 Fix: `checkDependsOnResolved` must not fire before PR is merged

**Current bug**: `checkDependsOnResolved()` checks `task.status === 'completed'` only. The claim route
additionally requires `mergedAt IS NOT NULL` for any dependency with an open PR. So
`dispatchUnblockedTask()` fires when the task completes, but runners claim the gate and skip the
dependent task on every poll — silent busy-wait.

**Fix** in `apps/web/src/lib/task-dependencies.ts`:

In `checkDependsOnResolved()`, after fetching dependency statuses, also fetch worker PR state:

```typescript
// For each dependency, check whether it has an open (unmerged) PR
const depWorkers = await db
  .select({ taskId: workers.taskId, prUrl: workers.prUrl, mergedAt: workers.mergedAt })
  .from(workers)
  .where(
    and(
      inArray(workers.taskId, Array.from(allDepIds)),
      isNotNull(workers.prUrl),
    )
  )
  .orderBy(desc(workers.createdAt));

// Build a map: taskId → has open PR (prUrl set, mergedAt null)
const openPrMap = new Map<string, boolean>();
for (const w of depWorkers) {
  if (w.taskId && !openPrMap.has(w.taskId)) {
    openPrMap.set(w.taskId, w.mergedAt === null);
  }
}

// A dependency is "resolved" only if completed AND (no PR, or PR merged)
const allResolved = deps.every((depId) => {
  const status = statusMap.get(depId);
  const hasOpenPr = openPrMap.get(depId) ?? false;
  return status === 'completed' && !hasOpenPr;
});
```

This ensures `TASK_UNBLOCKED` and `dispatchUnblockedTask()` only fire when the gate is actually
clear — matching the claim route's enforcement.

#### 5.4 Webhook path (external merge)

When a PR is merged externally (from GitHub UI or `gh` CLI), the existing webhook handler
(`handlePullRequestEvent`, `action: 'closed' && pr.merged`) already sets `workers.mergedAt`.

Ensure the webhook then calls `checkDependsOnResolved(task.id)` with the corrected version from §5.3.
The current code already calls `resolveCompletedTask()` which calls `checkDependsOnResolved()` — but
only if the task was not already completed. Add an explicit `checkDependsOnResolved(task.id)` call
in `handlePullRequestEvent` on merge, unconditionally, so PR-merge unblocks dependents even if the
task was marked completed before the PR landed.

#### 5.5 Poll backstop

Runner poll (`POST /api/workers/claim`) already enforces the merged gate in SQL. This is the
backstop if Pusher events are missed: runners never claim blocked tasks, and when the PR merges,
the next poll after `dispatchUnblockedTask()` will find the task claimable.

`dispatchUnblockedTask()` (via Pusher `TASK_ASSIGNED` event + webhook + GitHub Actions dispatch) is
the primary wake signal. Poll alone is sufficient as a backstop — the runner will discover the task
on its next cycle (typically within 30–60 seconds).

No runner-side "seen/skip cache" exists today that would require clearing. Verify before
implementation by grepping for any skip-list or cooldown set in `apps/runner/`.

---

### 6. States + Copy Reference

#### Task status labels (user-visible)

| Internal state | User-visible label | Context |
|---|---|---|
| `pending` (no gate) | "Pending" | Waiting for a runner |
| `pending` (gate present) | **"Blocked"** | Derived from dependency check; not stored |
| `assigned` / `in_progress` | "Queued" | Claimed, not yet running |
| `running` | "Running" | Agent actively working |
| `waiting_input` | "Needs Input" | Agent waiting for human response |
| `completed` | "Done" | Task finished |
| `completed` (unmerged PR) | "Done · PR open" | Activity feed only |
| `failed` | "Failed" | Terminal error |
| `cancelled` | "Cancelled" | Superseded or manually cancelled |

#### Gate surface microcopy

| Surface | Copy |
|---|---|
| Home "Waiting on you" row | `PR #N — {title}  ·  {N} tasks waiting` |
| Home [Merge] button | `Merge` |
| Home merge confirmation (inline) | `Merging will automatically start {N} queued tasks.` |
| Task page banner | `Blocked by "{title}" — PR #N  ·  Merge to start this task automatically.` |
| Task page Start button tooltip | `Blocked — merge PR #N first` |
| Mission gate chip | `Awaiting your review — PR #N  ·  Merge to continue` |
| Notification (Pushover/web) | `PR #N ready for review — {N} tasks waiting on merge` |
| Activity feed pill | `Unmerged` |

---

### 7. Out of Scope

- **Full PR diff/review UI inside buildd**: not in scope. Link out to GitHub for diff review; buildd
  provides only the Merge action. The [Review PR ↗] link opens GitHub in a new tab.
- **PR comments / code review from buildd**: out of scope.
- **Multi-PR fan-out gates** (one dependent task blocked by multiple PRs across different tasks):
  the current `dependsOn` model handles this correctly — all listed task IDs must have resolved PRs.
  No new UX needed for this case; the gate chip and banner would list all unresolved PRs.
- **Auto-merge of gating PRs**: the platform does NOT auto-merge review gates. Auto-merge (§G4 of
  `worker-pr-automerge.md`) applies to non-gate PRs. Gates require explicit human approval because
  they checkpoint cross-phase work.

---

## Build Tasks

The following discrete implementation tasks should be filed for approval after Max reviews this spec.
Each is independently shippable in the order listed.

| # | Title | Files / areas | Notes |
|---|---|---|---|
| BT-1 | **Fix `checkDependsOnResolved` to gate on PR merged** | `apps/web/src/lib/task-dependencies.ts` | §5.3. Test: dependent task NOT dispatched when dep has open PR; IS dispatched after mergedAt set. |
| BT-2 | **Add `blockingGate` to task summary API** | `apps/web/src/app/api/tasks/[id]/summary/route.ts`, `packages/shared/src/types.ts` | §2.1. Returns `{ taskId, prUrl, prNumber, taskTitle }` or null. |
| BT-3 | **Blocked task page banner + Start button tooltip** | `apps/web/src/app/app/(protected)/tasks/[id]/` | §2.2–2.3. Requires BT-2. |
| BT-4 | **'Waiting on you' home section** | `apps/web/src/app/app/(protected)/home/page.tsx` | §1.1. Requires BT-2 (or a dedicated gate-list API endpoint). |
| BT-5 | **Activity feed 'Unmerged' pill** | Home page Activity rail | §1.2. No deps. |
| BT-6 | **Review gate notification** | `apps/web/src/lib/task-dependencies.ts`, `apps/web/src/lib/pusher.ts`, `apps/web/src/lib/notify.ts` | §4. Add `REVIEW_GATE_OPENED` event; call `notifyTeam()` on gate open. |
| BT-7 | **Merge endpoint `POST /api/prs/[prNumber]/merge`** | `apps/web/src/app/api/prs/[prNumber]/merge/route.ts` | §5.1. Requires `mergePullRequest()` + branch delete + BT-1. |
| BT-8 | **`mergedBy` column migration** | `packages/core/db/schema.ts` | §5.1. `bun db:generate` + commit migration. |
| BT-9 | **Mission view gate chip** | `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` | §3. Requires BT-2 or inline gate detection. |
| BT-10 | **Webhook: call `checkDependsOnResolved` on PR merge unconditionally** | `apps/web/src/app/api/github/webhook/route.ts` | §5.4. Ensures external merges also unblock dependents. Requires BT-1. |

**Order recommendation**: BT-1 → BT-2 → BT-3 + BT-5 (parallel) → BT-4 → BT-6 → BT-7 → BT-8 → BT-9 → BT-10.

BT-1 is the highest-leverage fix: it eliminates the silent busy-wait and is a pure correctness patch
with no UI changes.

---

## Test Plan

### Unit tests

| File | Test |
|---|---|
| `apps/web/src/lib/task-dependencies.test.ts` | `checkDependsOnResolved` does NOT fire `TASK_UNBLOCKED` when dependency has open PR (`mergedAt IS NULL`) |
| same | `checkDependsOnResolved` fires `TASK_UNBLOCKED` after `mergedAt` is set |
| same | `resolveCompletedTask` fires `REVIEW_GATE_OPENED` pusher event when task completes with PR + dependents |
| same | `resolveCompletedTask` does NOT fire `REVIEW_GATE_OPENED` when task has no dependents |
| `apps/web/src/app/api/prs/[prNumber]/merge/route.test.ts` | Merge endpoint calls `mergePullRequest()` + `deleteRef()` + sets `mergedAt` |
| same | Merge endpoint returns 403 for caller without workspace access |
| `apps/web/src/app/api/tasks/[id]/summary/route.test.ts` | Task summary includes `blockingGate` when upstream has open PR |
| same | Task summary returns `blockingGate: null` after upstream PR merged |

### Integration smoke tests

- Task A completes with PR open → Task B (`dependsOn: [A]`) shows as `blocked:gate` in the API
- Merge PR for Task A → Task B dispatched within 5s (Pusher or next poll)
- Home page shows "Waiting on you" row with correct blocked count
- Notification fires once on gate open; does NOT re-fire on next poll
- Merge via `/api/prs/[prNumber]/merge` → branch deleted; `mergedAt` set; `blockedTasksUnblocked` count returned

---

## Migration / Rollout

1. **BT-8 migration** (`mergedBy` column): additive, nullable — safe to deploy independently. Run
   `bun db:generate && bun db:migrate` and commit migration files.
2. **BT-1** (`checkDependsOnResolved` fix): pure logic change, no schema change. Fixes the silent
   busy-wait. Deploy before UI changes so the backend is correct before the frontend surfaces it.
3. **BT-6** (notification): additive Pusher event + `notifyTeam()` call. No schema change.
4. **BT-7** (merge endpoint): new route; no breaking changes to existing paths.

Each task is independently deployable. No feature flags required. Worst-case rollback: revert the
`checkDependsOnResolved` change (BT-1); existing behavior (premature dispatch, silent skip) resumes.

---

## Approval Gate

This spec is for Max's review only. No implementation should begin until:

1. Max approves this spec (or provides revision feedback).
2. Build tasks BT-1 through BT-10 are filed (can be filed in bulk from this doc after approval).
3. Each implementation task follows TDD: failing test first, then implementation.

# Path Claims as a Coordination Primitive

**Status:** Proposed
**Related:**
`apps/web/src/app/api/tasks/[id]/path-claim/route.ts`,
`apps/web/src/app/api/mcp/route.ts` (check_path_claim tool, lines 297–325 / 595–718),
`packages/core/path-overlap.ts` (pathsOverlap, serializeBatchByManifest, findBlockingPr),
`apps/web/src/app/api/workers/claim/route.ts` (siblingTaskManifests injection, lines 1381–1404; path-overlap backstop, lines 925–939),
`apps/web/src/app/api/workers/[id]/route.ts` (pendingInstructions delivery, lines 1676–1692),
`packages/core/db/schema.ts` (tasks.pathManifest, missions.mergePolicy),
`docs/design/change-intent.md` (changeIntents table — complementary but separate surface),
`docs/design/merge-policy.md` (MergePolicy primitive)

---

## Problem

The platform serializes parallel agent tasks through two mechanisms today:

1. **Declared-intent serialization** — `tasks.pathManifest` is set at creation time, and `serializeBatchByManifest()` inserts `dependsOn` edges between tasks with overlapping manifests when a mission batch is created. The claim loop backstop (`findBlockingPr` in `packages/core/path-overlap.ts`) defers a task whose manifest overlaps an open PR's task.

2. **Mid-task path expansion** — `check_path_claim` (MCP tool, also `POST /api/tasks/[id]/path-claim`) lets a running worker atomically extend its `pathManifest` via CAS when it discovers it needs to touch a file outside its original declaration.

Both mechanisms share a critical scoping defect: sibling lookup uses `missionId` when the task belongs to a mission, and falls back to workspace only for mission-less tasks. The current code in `apps/web/src/app/api/tasks/[id]/path-claim/route.ts` (line 102):

```typescript
currentTask.missionId ? eq(tasks.missionId, currentTask.missionId) : undefined,
```

**Consequence**: two tasks in _different_ missions can both claim the same file without any conflict detection. This is what happened with PRs #1759 and #1762: "drop legacy autoMerge\* fallback" and "add Zod schema for MergePolicy" both worked on `packages/core/merge-policy.ts` and related files. Because those tasks were in separate missions (or one was mission-less), `check_path_claim` would not have caught the overlap even if it had been called.

Beyond the scope bug, the current design has three more gaps:

- There is no `path_claims` table — the held lock and the declared intent are the same field (`tasks.pathManifest`). This makes it impossible to release holds independently of the intent record.
- On 409, the caller is told to "report blocked so a `dependsOn` edge can be added." This is manual and error-prone; there is no waiter registration, so releases don't fan out.
- Workers have no structured channel to ask each other about path ownership. Ad-hoc prompts through `send_agent_message` create free-form conversations with no rate limits, no hop cap, and no loop guard.

---

## Current State

### `pathsOverlap()` — `packages/core/path-overlap.ts` lines 24–46

Pure function; no DB access. Exact path equality + directory-prefix matching. Globs are treated as literal strings (not evaluated). `**` is a sentinel: if either array contains `**`, the function returns `true` unconditionally.

### `check_path_claim` — MCP tool + REST endpoint

- MCP route: `apps/web/src/app/api/mcp/route.ts`, lines 595–718. Available to worker and admin tokens.
- REST endpoint: `apps/web/src/app/api/tasks/[id]/path-claim/route.ts` — same logic, exposed for non-MCP callers.
- CAS loop (3 attempts): reads `tasks.pathManifest`, checks siblings, updates via `IS NOT DISTINCT FROM` guard.

### siblingTaskManifests injection — `apps/web/src/app/api/workers/claim/route.ts` lines 1381–1404

At claim time, the claim route injects `siblingTaskManifests` (workspace-scoped) into the worker response so agents know what other active tasks own before they start. This is advisory; it doesn't block claiming.

### `pendingInstructions` delivery — `apps/web/src/app/api/workers/[id]/route.ts` lines 1676–1692

`send_agent_message` writes to `workers.pendingInstructions`. On the next `PATCH /api/workers/[id]`, the field is read, cleared, and returned as `instructions` in the response. This is the existing delivery channel for human-to-agent steering.

### `path_claims` table — does NOT exist today

`tasks.pathManifest` is the sole record of both intent and hold. There is no separate claim table, no waiter queue, and no release event.

---

## Proposal

### 1. Scope: workspace is the floor

**Decision**: Remove the `missionId` filter from all sibling lookups in path-claim conflict detection. The workspace is always the scope for conflict checks. Mission membership is retained for other purposes (listed below) but must not gate whether two tasks see each other as siblings.

**What mission membership still governs:**

| Concern | Mechanism | Still mission-scoped? |
|---|---|---|
| Path-conflict detection | `check_path_claim`, claim-loop backstop | **No — workspace-scoped** |
| siblingTaskManifests injection | claim route, advisory only | **No — workspace-scoped** (already is) |
| MergePolicy resolution | `missions.mergePolicy` overrides `workspaces.gitConfig.mergePolicy` | Yes |
| Mission budget/concurrency gates | claim loop, mission row | Yes |
| Task notes / guidance delivery | `missionNotes`, `send_agent_message` target | Yes |
| Priority propagation | mission → task | Yes |

**Worked example — #1759/#1762 merge-policy collision:**  
PR #1759 ("drop legacy autoMerge\* fallback") and PR #1762 ("add Zod schema for MergePolicy") both modified `packages/core/merge-policy.ts`. If these tasks had been in separate missions (a plausible scenario — one a refactor mission, one a feature mission), the `missionId`-scoped sibling check would have let both workers claim the same file. With workspace-scoped siblings, the second task's `check_path_claim` call on `merge-policy.ts` would have hit a 409 and blocked until the first PR merged or closed.

**Code change (one-liner fix per call site):**

```typescript
// BEFORE
currentTask.missionId ? eq(tasks.missionId, currentTask.missionId) : undefined,
// AFTER — remove this condition entirely; workspace_id filter is already present
```

The same change applies to the identical block in `apps/web/src/app/api/mcp/route.ts` line 649.

---

### 2. Claim Lifecycle

#### 2a. `path_claims` table

```sql
CREATE TABLE path_claims (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  claimed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at  TIMESTAMPTZ             -- NULL = active hold
);

-- Active claim lookup: "who holds this exact path?"
CREATE INDEX path_claims_active_idx ON path_claims (workspace_id, path)
  WHERE released_at IS NULL;

-- Release sweep: "release all claims for task X"
CREATE INDEX path_claims_task_idx ON path_claims (task_id)
  WHERE released_at IS NULL;
```

There is no DB-level uniqueness constraint on `(workspace_id, path)` because conflict detection requires prefix matching (a claim on `apps/web/src/lib` blocks `apps/web/src/lib/foo.ts`). Uniqueness is enforced at the application layer by `pathsOverlap()`.

#### 2b. Declared intent vs held lock

| Concept | Storage | Written by | Read by |
|---|---|---|---|
| Declared intent | `tasks.pathManifest` | Task creation, `check_path_claim` (mirror) | Claim-loop backstop (`findBlockingPr`), `siblingTaskManifests` injection at claim time |
| Held lock | `path_claims` (active rows) | `check_path_claim` (new path) | `check_path_claim` conflict scan |

**Task creation**: writes `tasks.pathManifest`; does **not** auto-insert `path_claims` rows. The claim is not held until the worker actively calls `check_path_claim`. Rationale: a task may be pending for minutes or hours before a worker starts it. Pre-inserting claims that long would starve concurrent tasks.

**`check_path_claim` on success**: inserts one `path_claims` row per new path AND appends the path to `tasks.pathManifest` (to keep the intent record current for the claim-loop backstop). The CAS guard moves from the `tasks.pathManifest` comparison to a "no active claim exists for this path" check on `path_claims`.

**`check_path_claim` conflict scan**: queries `path_claims WHERE workspace_id = $ws AND released_at IS NULL`, then runs `pathsOverlap()` in application code to handle prefix matching. Returns 409 on first hit.

#### 2c. `**` wildcard decision table

| Wildcard in | Treatment | Rationale |
|---|---|---|
| `tasks.pathManifest` (declared intent, `**` written at creation) | **Advisory-only** — claim-loop backstop skips the `findBlockingPr` call when the candidate manifest is `['**']` | A task that declares `**` is saying "I don't know my scope yet." Treating it as a hard repo-wide lock would stall all other work indefinitely on any broad task. |
| `path_claims` (held lock, written by `check_path_claim`) | **Advisory-only** — `check_path_claim` rejects the claim with a 400 ("wildcard claims are not supported; declare specific paths") | A worker that calls `check_path_claim(['**'])` mid-task is almost certainly wrong. The tool requires specific paths so the claim is meaningful. |
| A sibling's `tasks.pathManifest` contains `**` | **Advisory-only** — the conflict check treats `**` siblings as non-blocking | Same rationale: `**` intent manifests are placeholders, not genuine scope locks. |

**Crux**: `**` is advisory everywhere. A task with `**` never blocks another task at the path-claim layer. If scope isolation for broad tasks is required, the orchestrator should break the task into scoped subtasks or use mission-level `maxConcurrentTasks = 1`.

#### 2d. Release triggers

All four release signals already have hook points; no new cron is required.

| Trigger | Existing hook point | Action |
|---|---|---|
| Terminal task status (completed / failed / cancelled) | `PATCH /api/workers/[id]`, post-update block where `isTerminalStatus` is true (line ~1710) | `UPDATE path_claims SET released_at = NOW() WHERE task_id = $taskId AND released_at IS NULL` |
| PR merged | GitHub webhook → auto-merge handler (`apps/web/src/lib/auto-merge.ts`) — already handles `mergedAt` | Same release query, triggered by `prLifecycleStatus = 'merged'` |
| PR closed/abandoned | GitHub webhook → existing `prLifecycleStatus = 'closed'` path | Same release query |
| Worker reaped or aborted | Worker reaper (existing periodic scan for stale/hung workers) | Add release query to reaper cleanup block |

#### 2e. Orphan / stale claim handling

When a runner dies without posting a terminal status, its `path_claims` rows stay active. The worker reaper already identifies orphaned workers (stale heartbeat, no recent PATCH). The reaper cleanup block should release claims for those workers as part of the same sweep. No new mechanism is needed beyond wiring the release query into the existing reaper.

---

### 3. Waiter Queue

#### 3a. Registration on 409

When `check_path_claim` returns 409, the platform atomically registers the requesting task as a waiter:

```sql
CREATE TABLE path_claim_waiters (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  blocking_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  waiting_task_id  UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_path     TEXT NOT NULL,
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at      TIMESTAMPTZ,      -- NULL = not yet notified
  UNIQUE (blocking_task_id, waiting_task_id, blocked_path)
);
```

The 409 response remains unchanged for the caller (same `blockingTaskId`, `message`). Registration is a server-side side-effect; the worker does not need to call a separate "register waiter" endpoint.

If the waiting task is already terminal when `check_path_claim` fires, the 400 guard (`Cannot claim paths for a task with status...`) prevents waiter registration.

#### 3b. Fan-out on release

When a `path_claims` row is released (by any trigger in §2d):

1. **Live workers** — emit a Pusher event on `workspace:{workspaceId}` channel:
   ```json
   { "event": "path_claim_released", "taskId": "<released_task_id>", "paths": ["..."] }
   ```
   Live workers subscribed to the workspace channel receive this event and can retry their `check_path_claim` call immediately. Retrying is optional; the worker may choose to proceed with its current approach.

2. **Queued tasks** — the claim loop already polls for pending tasks on each request. Once claims are released, any deferred task whose manifest no longer overlaps an active claim or open PR is eligible on the next poll. No push is needed for queued tasks — poll-based discovery is sufficient and avoids complexity.

#### 3c. Hard block vs advisory nudge

| Waiter type | Behavior |
|---|---|
| Live worker (already running, hit a 409 mid-task) | **Advisory nudge** — the worker receives the Pusher event and may retry, but is not forced to wait. It can choose to report blocked, ask the human, or take a different approach. |
| Pending task (not yet claimed, deferred by the claim-loop backstop) | **Hard block** — the task stays `pending` and is not claimable until the blocking PR closes or the blocking task reaches terminal status. |

#### 3d. Multi-waiter contention

When multiple tasks are waiting on the same released claim, the platform does not orchestrate which task proceeds first — the claim loop picks up whichever task it sees first on the next poll, subject to priority and concurrency caps. This produces priority-weighted, approximately FIFO behavior without a dedicated scheduler.

**Starvation guard**: if a task has been in the waiter queue for more than `STARVATION_THRESHOLD_MINUTES` (default 60) without being notified of a release, the platform posts a mission note (`type: warning`) and optionally a Pushover alert. No automatic priority promotion — escalation is for human visibility, not automated re-ordering.

---

### 4. Worker-to-Worker Messaging (`send_worker_message`)

#### 4a. Surface

New MCP tool, available to worker and admin tokens (same auth level as `check_path_claim`).

```typescript
// Tool definition (added alongside check_path_claim in apps/web/src/app/api/mcp/route.ts)
{
  name: "send_worker_message",
  description: `Send a structured message to another active worker in this workspace.
Use this to coordinate on path conflicts, share findings, or ask a targeted question.
The recipient receives the message on their next update_progress call.
Rate-limited: 10 messages per sender per hour, 3 pending per recipient.`,
  inputSchema: {
    type: "object",
    properties: {
      toTaskId:  { type: "string", description: "Task ID of the recipient." },
      type: {
        type: "string",
        enum: ["path_blocked_on_you", "path_released", "question", "answer"],
      },
      body: { type: "string", maxLength: 500 },
      replyTo: { type: "string", description: "Message ID this is replying to (for answer type)." },
    },
    required: ["toTaskId", "type", "body"],
  },
}
```

#### 4b. Message envelope

```typescript
interface WorkerMessage {
  id: string;           // server-generated UUID
  type: 'path_blocked_on_you' | 'path_released' | 'question' | 'answer';
  fromTaskId: string;
  fromTaskTitle: string;
  toTaskId: string;
  sentAt: string;       // ISO 8601
  body: string;         // max 500 characters
  hopCount: number;     // 0 on first send; incremented when a worker replies
  replyTo?: string;     // message ID for answer type
}
```

#### 4c. Delivery

Messages are stored in `workers.pendingWorkerMessages` (JSONB array on the recipient's active worker row, max 3 entries; oldest dropped on overflow). On the next `PATCH /api/workers/[id]`, the pending messages are appended to the `instructions` field alongside `pendingInstructions` and cleared.

If the recipient task is already terminal (no active worker), the message is silently dropped (logged but not errored). The sender receives a `{ delivered: false, reason: "recipient_terminal" }` response.

#### 4d. Minimum message type semantics

| Type | Sender intent | Platform action |
|---|---|---|
| `path_blocked_on_you` | "I tried to claim X but you hold it; please release when done" | Delivered as instruction; no platform-side side-effect |
| `path_released` | "I've finished with X; you can now claim it" | Delivered as instruction; triggers waiter fan-out fan-out path if X is actually released |
| `question` | "I need information before proceeding" | Delivered as instruction; starts a `question`→`answer` thread |
| `answer` | "Here is the answer to your question" | Delivered as instruction; references `replyTo` |

#### 4e. Rate limits and abuse prevention

| Limit | Value | Rationale |
|---|---|---|
| Messages per sender per hour | 10 | Prevents a busy task from spamming all siblings |
| Pending messages per recipient | 3 (oldest dropped) | Keeps delivery buffer bounded |
| Max body length | 500 characters | Forces structured information exchange, not essays |
| Hop cap | 3 hops | `hopCount` is incremented by the server on each forward/reply. Messages with `hopCount >= 3` are rejected with a clear error. |
| No relay | Enforced | A message from task A to task B cannot be forwarded to task C. The `toTaskId` on a send must be in the same workspace and must not be the sender's own task. |

**Ping-pong loop guard**: the hop cap is the primary mechanism. A question sent from A to B (`hopCount=0`), answered from B to A (`hopCount=1`), followed by a follow-up from A to B (`hopCount=2`), and a final answer (`hopCount=3`). A fifth message would be rejected. Tasks that need more dialogue should involve a human via `send_agent_message` or `post_note`.

---

### 5. Failure Modes

#### 5a. Deadlock

**Scenario**: Task A holds path X and calls `check_path_claim(['y'])`. Task B holds path Y and calls `check_path_claim(['x'])`. Both return 409 and register as waiters for each other. Neither can proceed.

**Detection**: On each waiter registration, the platform performs a cycle check — a BFS from the new `(blocking_task_id, waiting_task_id)` edge to determine whether a path back to `waiting_task_id` already exists in the waiter graph. If a cycle is detected, the registration is rejected with a 409 body containing `{ deadlock: true, cycle: ["task-A-id", "task-B-id"] }`.

**Resolution**: The calling task (the one that would have closed the cycle) receives the deadlock signal and must report blocked for human resolution. The platform posts a mission note with `type: warning` naming both tasks. No automatic resolution — a human must cancel one task or adjust scope.

#### 5b. Starvation

**Scenario**: Task C holds a popular path (e.g., `packages/core/db/schema.ts`). Tasks D, E, and F queue as waiters. Task C finishes and releases, but task G immediately claims the path before D can start. This repeats.

**Mitigation**: The claim loop does not enforce strict FIFO across poll cycles; starvation is possible. The starvation guard (§3d) fires after 60 minutes to alert a human. A human can then force-start the starved task (`capExempt=true`) or cancel the competing tasks.

No automatic priority promotion is implemented — this is a deliberate non-goal. Automated priority escalation creates emergent behavior that is hard to reason about.

#### 5c. Released claim with open PR

**Scenario**: Task A finishes (`status: completed`), its claims are released. Task A's PR is still open (not merged). Task B now claims the same path and starts editing the same files. If both PRs merge, the second merge will conflict.

**Mitigation layer 1**: `tasks.pathManifest` is NOT cleared on task completion. The claim-loop backstop (`findBlockingPr`) reads active `workers` rows with `prUrl != null AND mergedAt IS NULL AND prLifecycleStatus != 'closed'`. As long as Task A's PR is open, a new task with an overlapping manifest will be deferred at claim time.

**Mitigation layer 2**: the `changeIntents` table (see `docs/design/change-intent.md`) tracks open PRs that touch conflict surfaces. It provides an additional backstop at PR-open time.

**Residual risk**: if the claim loop dispatches Task B after Task A completes but before Task A's PR is opened (a narrow window in the completions→push→open-PR sequence), B could start before the backstop fires. This window is narrow but not zero. Acceptable for the current design; can be closed later by blocking claims until `prUrl` is set.

---

## Decision Table — Wildcard (`**`) Handling

| Call site | `**` present | Behavior | Justification |
|---|---|---|---|
| `tasks.pathManifest` declared at creation | In candidate task's manifest | Backstop skipped (no `findBlockingPr` call) | Unknown scope; don't block others on uncertainty |
| `tasks.pathManifest` declared at creation | In a sibling's manifest | Sibling treated as non-blocking | Sibling's scope unknown; can't legitimately claim it blocks all files |
| `check_path_claim` caller passes `['**']` | In the paths array | 400 error — wildcard not a valid held claim | Tool requires actionable paths |
| `path_claims` active rows | Would-be match against `**` | `**` can never be inserted; 400 prevents it | N/A |

**Summary**: `**` is advisory everywhere. It signals scope uncertainty, not ownership. Tasks that need to exclusively own a broad surface should instead use `maxConcurrentTasks: 1` at the mission level.

---

## What We Are NOT Building

- **A distributed lock service.** Claims live in Postgres and are checked by application code. There is no ZooKeeper, Redis SETNX, or similar external coordinator.
- **Polling or cron-based claim refresh.** Claim expiry is event-driven (terminal status, PR merge/close, worker reaper). No periodic sweep job is introduced.
- **Full agent-to-agent chat.** `send_worker_message` is type-constrained and rate-limited. It is not a free-form message channel.
- **Cross-workspace claim serialization.** The workspace is the coordination boundary. Two workspaces can edit the same file without conflict detection.
- **Glob evaluation in `pathsOverlap()`.** Globs remain literal strings. `apps/web/**` is not expanded to all files under that directory.
- **Automatic priority re-ordering for starved waiters.** Humans escalate; the platform does not modify priority autonomously.
- **Per-path lock granularity below the task level.** A task holds a set of paths; there is no line-range or hunk-level locking.

---

## Phased Build Order

Each phase is independently shippable. File as separate build tasks.

### Phase 1 — Scope fix (no migration)

**Deliverables**:
- Remove `missionId` filter from sibling query in `apps/web/src/app/api/tasks/[id]/path-claim/route.ts` (line 102)
- Same removal in `apps/web/src/app/api/mcp/route.ts` (line 649)
- Add `**` advisory-only guard: in `check_path_claim`, if `paths.includes('**')`, return 400 immediately
- In `findBlockingPr` backstop, skip when `candidateManifest.includes('**')`

**Tests**: update existing `check_path_claim` tests to cover cross-mission conflict detection; add `**` advisory test.

### Phase 2 — `path_claims` table and release triggers

**Deliverables**:
- Schema: `path_claims` table + indexes (Drizzle migration)
- `check_path_claim` writes to `path_claims` on success (in addition to updating `tasks.pathManifest`)
- Release trigger in `PATCH /api/workers/[id]` — on terminal status, soft-delete active claims
- Release trigger in GitHub webhook handler — on PR merge and PR close
- Release trigger in worker reaper — on orphaned worker cleanup
- Claim-loop backstop updated to also read `path_claims` (active rows) in addition to open PR task manifests

**Tests**: claim released on terminal status; orphaned claim released by reaper; claim-loop skips task with active sibling claim.

### Phase 3 — Waiter queue and fan-out

**Deliverables**:
- Schema: `path_claim_waiters` table (Drizzle migration)
- 409 response auto-registers waiter
- Release trigger emits `path_claim_released` Pusher event on workspace channel
- Starvation guard: background scan for waiters older than 60 minutes → mission note + Pushover
- Deadlock detection: BFS cycle check on waiter registration

**Tests**: waiter registered on 409; Pusher event fired on release; deadlock returns `{ deadlock: true, cycle }`.

### Phase 2b — Shared helper extraction (prerequisite for Phase 2)

**Deliverables**:
- Extract sibling-overlap query into `checkPathClaimConflict(taskId, paths, db)` in new `packages/core/path-claim.ts`
- Update `apps/web/src/app/api/tasks/[id]/path-claim/route.ts` and `apps/web/src/app/api/mcp/route.ts` to use the shared helper
- Pure `pathsOverlap` / `findBlockingPr` / `serializeBatchByManifest` remain in `packages/core/path-overlap.ts`

**Tests**: no behaviour change — existing tests pass with new call sites.

### Phase 3b — PreToolUse hook (auto-claim on first write)

**Deliverables**:
- `PreToolUse` hook in runner harness targeting `Edit` and `Write` tool names
- Calls `POST /api/tasks/{taskId}/path-claim` with 200ms timeout
- Fail-open: on timeout/error, enqueue path locally and flush on next successful claim or `update_progress`
- `pendingPaths` field in `update_progress` PATCH body for retroactive registration
- Workspace-level `gitConfig.pathClaimMode: 'advisory' | 'strict'` setting (default `advisory`)
- In strict mode: hook blocks the Edit/Write and returns advisory response (including `blockingManifest`)

**Tests**: hook fires on Edit; fail-open proceeds on timeout; strict mode blocks on 409; queued paths flushed on next check-in.

### Phase 3c — Passive collision detection

**Deliverables**:
- `workers.touchedPaths` JSONB column (schema migration); cumulative, capped at 500 paths
- `update_progress` accepts `touchedPaths: string[]` (incremental, server appends to cumulative)
- Server-side `pathsOverlap()` check against all active workers in workspace on each check-in
- On overlap: emit `path_overlap_detected` Pusher event on workspace channel + mission note warning
- `touchedPaths` cleared on terminal worker status

**Tests**: overlap detected on check-in; Pusher event fired; no block on `update_progress` 200; cap enforced at 500.

### Phase 4 — Worker-to-worker messaging

**Deliverables**:
- `send_worker_message` MCP tool (alongside `check_path_claim` in `apps/web/src/app/api/mcp/route.ts`)
- `workers.pendingWorkerMessages` JSONB column (schema migration)
- Delivery on `PATCH /api/workers/[id]`: append to `instructions`, clear column
- Rate limit enforcement (10/hour per sender, 3 pending per recipient)
- Hop cap: server increments `hopCount` on each message, rejects at `>= 3`
- Terminal-recipient guard: return `{ delivered: false, reason: "recipient_terminal" }` silently

**Tests**: message delivered on next PATCH; rate limit returns 429; hop cap blocks loop at 4th message; message dropped for terminal recipient.

---

---

## 6. Declared vs Observed Claims

### 6a. What path claims actually protect

Workers run in **isolated git worktrees** (see `apps/runner/src/worktree-utils.ts`). Concurrent edits to the same file never corrupt each other at write time — each worker edits its own copy on its own branch. A path claim is therefore **not protecting a file from concurrent writes**. It is **serializing merge intent**: ensuring that two branches that modify the same file do not land in the same merge window without a human or agent reviewer being aware.

This changes what "early detection" buys:

- **Detecting at first Edit/Write**: caps the wasted work at a few turns before the conflict is visible. The worker stops before investing a whole branch in a dead end.
- **Detecting at merge time**: by then both branches are complete, one must be rebased or reverted, and a conflict-resolution retry loop is required (typically 1–2 more full-agent cycles).

The value of earlier detection is bounded by how much work the agent has already done when the conflict is found. Four turns lost (early detection) versus a whole branch plus a retry loop (late detection) — this is the economic case for the hook in §6b.

### 6b. The gap: agent discipline is not a foundation

`check_path_claim` as shipped in PR #1774 depends on the agent choosing to call it. Declared `pathManifest` values are forward-looking guesses: a task description mentioning three files routinely results in edits to eleven, because the agent follows imports, touches tests, updates types, and corrects adjacent issues. The eight undeclared files are invisible to every other worker until the PR opens.

Two structural mechanisms close this gap without relying on agent discipline.

### 6c. Layer 1 — Auto-claim on first write (PreToolUse hook)

**Mechanism**: The runner harness registers a `PreToolUse` hook that fires before every `Edit` or `Write` tool call. The hook extracts the target file path and calls `POST /api/tasks/{taskId}/path-claim` with `{ paths: [targetPath] }` before the edit lands.

**Hook placement**: The hook is registered in the runner's tool-intercept layer, at the same level as the existing tool-call logging and MCP call recording. It is not a prompt change — it is a harness-level side-effect that the agent never sees. The implementation file is in `apps/runner/` (exact file TBD in the build task for Phase 1 of this layer).

**Manifest vs hook roles after this change**:

| Layer | What it covers | Source of truth? |
|---|---|---|
| `tasks.pathManifest` (declared at creation) | Files the orchestrator expects the task to touch | Scheduling hint — used by claim-loop backstop and `siblingTaskManifests` injection |
| `path_claims` rows written by hook | Files the worker actually touches, in order | **Ground truth** for held locks |
| `path_claims` rows written by explicit `check_path_claim` call | Files the agent consciously claims (existing mechanism) | Also ground truth; hook supplements, not replaces |

The manifest remains the up-front scheduling gate. The hook makes the actual-edit record continuous and automatic.

**Latency budget**: The hook adds one HTTP call per file write. The path-claim endpoint must respond within a **200ms timeout** (p99 target: <50ms with the `path_claims_active_idx` index). Edits that exceed this budget use the fail-open rule below.

**CRITICAL — fail-open rule**: An unreachable or slow control plane **must not stop a worker from writing code**. The hook must:

1. Set a 200ms timeout on the claim call.
2. On timeout or any network error: **proceed with the edit**. Log the unclaimed path locally (in-memory queue).
3. On the next successful claim call (whether for the same or a different path): flush the queued unclaimed paths by calling `check_path_claim` with the full queue.
4. If the queue has not been flushed by the next `update_progress` PATCH: include queued paths in a `pendingPaths` field in the PATCH body so the server can register them retroactively.

A worker that wrote to a path while the claim endpoint was down is not in a failure state — it is in a degraded-detection state. The platform records the paths once connectivity returns and handles the conflict the same way as a late detection.

**What the hook does NOT do**: block the edit on a 409. See §6e for the hard-block vs advisory decision.

### 6d. Layer 2 — Passive collision detection on check-in

The hook in §6c covers `Edit` and `Write` tool calls. It cannot cover:
- Shell commands that write files (`sed -i`, `awk`, `cp`) via the `Bash` tool
- Codegen scripts that touch hundreds of files
- Formatters (`prettier`, `gofmt`, `bun fmt`) that expand their scope autonomously
- A third-party agent that bypasses the hook entirely

**Mechanism**: Workers already POST `update_progress` to `PATCH /api/workers/{id}` at milestones. This call currently accepts a `filesChanged` count (integer). Extend the call body to also accept a `touchedPaths: string[]` field — an incremental list of file paths the worker has written to since its last check-in.

The server, on each `update_progress` call that includes `touchedPaths`, runs `pathsOverlap()` against the stored `touchedPaths` of every other active worker in the same workspace. If an overlap is detected:

1. Emit a `path_overlap_detected` Pusher event on the workspace channel naming both workers and the overlapping paths.
2. Post a mission note (`type: warning`) in the affected missions.
3. Do **not** reject the `update_progress` call — detection is passive, not blocking.

`touchedPaths` is stored in a new `workers.touchedPaths` JSONB column (cumulative; the server appends each check-in's incremental list). The column is cleared when the worker reaches a terminal status.

**Coverage rationale**: This layer requires no cooperation from any specific tool call. Any path that a worker reports via `update_progress` is automatically checked. It is the backstop for the hook gap and for any runner that does not implement the hook.

### 6e. Hard block vs advisory

| Trigger | Response | Justification |
|---|---|---|
| Path already held by an active `path_claims` row (detected by hook or explicit `check_path_claim`) | **Advisory by default; hard block if `--strict` mode is set per workspace** | Hard-blocking every Edit on a network call introduces latency on the critical path of agent work. The more useful response is "task X holds this, here is its manifest" (see below). Strict mode is opt-in at the workspace level for teams that need deterministic serialization. |
| Passive collision detected on `update_progress` (`touchedPaths` overlap) | **Advisory only — warning, no block** | By the time the check-in fires, the edit has already landed. Blocking the check-in would not undo the write; it would only prevent progress reporting. |

**Advisory response content** (on hook 409, non-strict mode):
```json
{
  "claimed": false,
  "blockingTaskId": "...",
  "blockingTaskTitle": "...",
  "blockingManifest": ["packages/core/merge-policy.ts", "..."],
  "message": "Task X holds this path. Consider sending a send_worker_message to coordinate, or proceeding and flagging the overlap in your PR description."
}
```

The response includes `blockingManifest` so the worker can reason about whether the actual overlap is material (both tasks editing the same function) or incidental (both tasks touching the same file in unrelated sections). This is the coupling point to `send_worker_message` (§4) — the worker can send a `path_blocked_on_you` message immediately from the hook's advisory response without any additional tool call.

**Deadlock and latency risks of strict mode**:
- Deadlock risk is the same as §5a, but triggered more frequently because the hook fires on every Edit rather than only on explicit `check_path_claim` calls. The cycle-check on waiter registration (§3d) must run on the hook path too.
- Latency risk: in strict mode, a slow control plane stalls every Edit. The fail-open rule (§6c) applies here too — strict mode hard-blocks only when the claim succeeds with a 409, not when the endpoint is unreachable.

### 6f. Extracting the sibling-overlap query into a shared helper

The sibling-overlap query — fetch active siblings, run `pathsOverlap()`, return first conflict — is currently duplicated in:

1. `apps/web/src/app/api/tasks/[id]/path-claim/route.ts` (lines 99–123)
2. `apps/web/src/app/api/mcp/route.ts` (lines 646–668)

The hook in §6c adds a **third** call site (the harness-side claim call goes to the same `POST /api/tasks/{taskId}/path-claim` endpoint, but the endpoint code itself is a third implementation of the same pattern once Phase 2 migrates from `tasks.pathManifest` to `path_claims`).

**Decision**: Extract into a single `checkPathClaimConflict(taskId: string, paths: string[], db: Db): Promise<ConflictResult | null>` function in `packages/core/path-overlap.ts` (or a new `packages/core/path-claim.ts` if the DB dependency is undesirable in the pure-function module). Both call sites import this helper; the hook uses the same endpoint as today, so it does not add a new call site at the code level.

This is a **Phase 2 prerequisite**: do it when migrating to `path_claims`, so all three conceptual call sites share one implementation from day one of the new table.

---

## Open Questions

1. **Should `path_claims` rows have a TTL column?** An explicit `expires_at` would let the DB enforce a backstop expiry independent of the reaper, catching very long-running tasks that never post a terminal status. Lean: yes, set to `claimed_at + 24h` with the reaper responsible for release; auto-expiry is a defense in depth, not a substitute for proper release.

2. **Should the claim-loop backstop read `path_claims` directly (Phase 2) or continue to rely on open PR task manifests?** Today `findBlockingPr` is cheap because it only checks workers with open PRs. Adding a `path_claims` scan widens the backstop to tasks that are running but haven't opened a PR yet. Lean: yes, add it in Phase 2 — the narrow window risk in §5c is the motivation.

3. **Should deadlock resolution be automatic (cancel the lower-priority task) or always human?** Lean: always human in Phase 3. Automatic cancellation is destructive and hard to reason about. Add automation in a later phase once the pattern is well understood.

4. **Should strict mode (hard-block on 409 from the hook) be a workspace setting or a per-task flag?** Lean: workspace setting, configured via `workspaces.gitConfig.pathClaimMode: 'advisory' | 'strict'`. Per-task flags add cognitive overhead; workspace-level is simpler and covers most use cases.

5. **Should `touchedPaths` be cumulative across the whole task lifetime or reset on each check-in?** Cumulative is more useful for collision detection (catches overlaps that span check-in boundaries) but unbounded. Lean: cumulative, capped at 500 paths per worker; paths beyond the cap trigger a warning but are not stored (the worker's scope is large enough that the mission should have `maxConcurrentTasks: 1`).

6. **Where does `checkPathClaimConflict` live — `packages/core/path-overlap.ts` or a new `packages/core/path-claim.ts`?** `path-overlap.ts` is currently pure (no DB). Adding a DB-dependent function would contaminate the module. Lean: new `packages/core/path-claim.ts` that imports from `path-overlap.ts` for the pure logic and adds the DB query layer.

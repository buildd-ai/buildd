# Path Claims as a Coordination Primitive

**Status:** Proposed
**Related:**
- `apps/web/src/app/api/tasks/[id]/path-claim/route.ts` (PR #1774 — current implementation)
- `apps/web/src/app/api/mcp/route.ts` (`check_path_claim` tool block)
- `packages/core/path-overlap.ts` (`pathsOverlap`, `findBlockingPr`)
- `apps/web/src/app/api/workers/[id]/route.ts` (update_progress delivery)
- `apps/web/src/app/api/workers/[id]/instruct/route.ts` (instructionHistory append)
- `packages/core/db/schema.ts` (`tasks.pathManifest`, `workers.instructionHistory`)
- `docs/design/change-intent.md` (predecessor coordination primitive)

---

## Problem

PR #1774 added `check_path_claim` — a best-effort guard that lets a worker
discover mid-task whether paths it wants to touch are claimed by a sibling.
Overlap detection reads `tasks.pathManifest` (a jsonb column). This works, but
has four concrete defects:

1. **No durable lock record.** A claim is implicit: "task T has status
   `in_progress` AND `pathManifest` contains path P." When T completes its PR
   merges and the task transitions to `completed`, the manifest is still in the
   row — other workers can race onto those paths while the PR is still open.

2. **No waiter queue.** A 409 tells the blocked worker to "report blocked and
   add a `dependsOn` edge." There is no mechanism to automatically notify that
   worker when the blocking task releases its paths.

3. **No cross-workspace isolation for release events.** Release signals (task
   terminal, PR merge) are processed by existing reconciliation routes but they
   don't know to look for waiters.

4. **No worker-to-worker channel.** A blocked worker cannot ask the holder a
   clarifying question ("are you changing the public API of `resolvePolicy()`?")
   without going through a human via `send_agent_message`.

The outcome: workers serialize poorly, block silently, and sometimes do
duplicate work on the same files.

---

## Current State

```
tasks.pathManifest: jsonb  -- ["packages/core/db/schema.ts", "apps/web/…"]
```

`check_path_claim` (route + MCP tool):
- Reads `tasks.pathManifest` of active sibling tasks in the same mission/workspace.
- On no overlap: CAS-appends the new paths to the caller's own `pathManifest`.
- On overlap: returns 409 with `blockingTaskId`.

`workers.instructionHistory: jsonb[]` — human steering messages (written by
`/api/workers/[id]/instruct`) are appended here and returned on the next
`update_progress` PATCH response. This is the delivery channel we reuse for
worker-to-worker messages.

---

## Proposal

### Crux

Move the authority for "who holds which paths" from `tasks.pathManifest` (which
doubles as the declaration of *intent*) to a new `path_claims` table (which
records *held locks*). The crux decision: **pathManifest stays as declared
intent; path_claims rows are the held locks**. `check_path_claim` writes claim
rows on success and reads them for overlap detection. Release is event-driven
(no new cron).

If this separation is wrong — e.g. if we keep both as authoritative — we get
split-brain: a task could hold a path_claims row but not have it in its manifest
(or vice versa), causing silent gaps.

---

### 1. `path_claims` Table Schema

```sql
CREATE TABLE path_claims (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id        uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path           text NOT NULL,
  claimed_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  release_reason text
);

-- Active-claim lookup (the hot path for overlap checks)
CREATE INDEX path_claims_active_idx
  ON path_claims (workspace_id)
  WHERE released_at IS NULL;

-- Per-task release (on task terminal or worker reap)
CREATE INDEX path_claims_task_idx
  ON path_claims (task_id)
  WHERE released_at IS NULL;
```

**One row per path per task.** A task declaring `pathManifest = ["a.ts",
"b.ts"]` that calls `check_path_claim(["a.ts", "b.ts"])` gets two rows.

**`release_reason`** is a short enum string for observability:
`task_completed`, `task_failed`, `task_cancelled`, `pr_merged`, `pr_closed`,
`worker_reaped`. Not a DB enum — keeping it `text` avoids a migration-per-reason
as the system evolves.

**Uniqueness**: no UNIQUE constraint on `(task_id, path)` — a task could
legitimately re-claim a path it already holds (idempotent insert: skip if an
active row exists). The overlap check ignores the caller's own rows.

**`tasks.pathManifest` stays.** It records *declared intent* at task-creation
time and feeds the claim-time overlap gate in the claim route. It is NOT removed.
`path_claims` is the *held-lock* layer on top.

**Wildcard `**` sentinel.** Tasks without a declared manifest receive `["**"]`
in `pathManifest` (per PR #1773). A `**` pathManifest MUST NOT generate a
`path_claims` row. Wildcard manifests remain advisory-only — they feed the
claim-time declared-intent check but cannot hold a repo-wide lock. A task with
`["**"]` that calls `check_path_claim` on a specific path goes through normal
overlap detection against active claim rows and succeeds if no sibling holds
that path. Implementation guard: `check_path_claim` rejects `paths = ["**"]`
as an invalid argument (400).

---

### 2. Updated `check_path_claim` API Contract

**Read side** — overlap detection:

```
SELECT task_id, path FROM path_claims
WHERE workspace_id = $workspaceId
  AND released_at IS NULL
  AND task_id != $callerTaskId
```

Apply `pathsOverlap(requestedPaths, [rows grouped by task_id])`. If overlap
found, return 409.

**Write side** — claim insertion:

On no overlap, insert one row per requested path:

```sql
INSERT INTO path_claims (workspace_id, task_id, path)
VALUES ($workspaceId, $taskId, $path)
ON CONFLICT DO NOTHING  -- idempotent: already held by this task
```

Also append the new paths to `tasks.pathManifest` (existing CAS logic) for
backward compatibility with the claim-time declared-intent check.

**On 409 — waiter registration:**

Register the blocked task as a waiter on the blocking claim. See §Waiter Queue.

**Response shapes** (unchanged from PR #1774 for 200; new fields on 409):

```jsonc
// 200
{ "claimed": true, "pathManifest": ["a.ts", "b.ts"] }

// 409
{
  "claimed": false,
  "blockingTaskId": "uuid",
  "blockingTaskTitle": "...",
  "paths": ["a.ts"],           // which specific paths conflict
  "message": "..."
}
```

**Scope of sibling check.** Workspace-wide. The missionId filter in PR #1774
is removed. Two tasks in different missions in the same workspace CAN block each
other. Rationale: a file like `packages/core/db/schema.ts` is workspace-shared
infrastructure; mission membership is not a valid isolation boundary.

---

### 3. Waiter Queue

**Storage: `path_claim_waiters` table** (separate table, not a jsonb column on
`path_claims`).

A jsonb column on `path_claims` cannot be efficiently queried for "all waiters
on any claim for path P" without a full table scan, and FIFO ordering requires
a sequence or timestamp. A separate table handles both cleanly.

```sql
CREATE TABLE path_claim_waiters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path_claim_id   uuid NOT NULL REFERENCES path_claims(id) ON DELETE CASCADE,
  waiter_task_id  uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  registered_at   timestamptz NOT NULL DEFAULT now(),
  notified_at     timestamptz  -- set when release fan-out fires
);

CREATE INDEX pcw_claim_idx ON path_claim_waiters (path_claim_id)
  WHERE notified_at IS NULL;
CREATE UNIQUE INDEX pcw_unique_idx
  ON path_claim_waiters (path_claim_id, waiter_task_id);
```

**On 409**, `check_path_claim` inserts a waiter row for every blocking
`path_claims` row (one blocker may hold multiple paths).

**Waiter semantics.** Waiting is an **advisory nudge**, not a hard block.
The blocked worker receives a notification (Pusher + next update_progress
response) when a claim releases; it is then responsible for re-calling
`check_path_claim`. The system does not re-attempt automatically — workers must
opt into retry logic. This avoids the complexity of automated re-queuing and
keeps the coordination primitive simple.

**Contention (multi-waiter).** On release, all waiters for the released claim
are notified concurrently. No FIFO enforcement: the first worker to
re-call `check_path_claim` wins. Priority tie-breaking (higher-priority tasks
win the re-claim) is a follow-on concern — premature optimization before we
observe real multi-waiter contention.

**Starvation guard**: none in v1. If starvation is observed (a low-priority
waiter never gets the path), add a `notBefore` timestamp on claim inserts that
enforces a minimum quiet window after release before accepting new claims. File
a follow-on task if this is needed.

---

### 4. Release Trigger Semantics

Claims are released by setting `released_at = now()` and `release_reason` on
the claim row(s) for the affected task. Release is triggered by existing
convergence signals — no new cron, no new background job.

| Signal | Existing hook | Release action |
|---|---|---|
| Task → `completed` / `failed` / `cancelled` | `PATCH /api/workers/[id]` terminal status write | Release all `path_claims` for `task.id` |
| PR merged | GitHub webhook → worker `mergedAt` update in `PATCH /api/workers/[id]` | Release all claims for `task.id` (guard: only if `mergedAt` was NULL before) |
| PR closed without merge | GitHub webhook → `prLifecycleStatus = 'closed'` in `PATCH /api/workers/[id]` | Release all claims for `task.id` |
| Worker reaped / aborted | Stale-worker reaper in `PATCH /api/workers/[id]` or admin abort | Release all claims for `task.id` |

**PR-merge vs task-completed ordering.** A task can complete (status →
`completed`) before its PR is merged. In this case, do NOT release claims on
task completion alone — wait for PR merge. Rationale: the code conflict is
still in-flight until the PR lands. Gate: only release on `pr_merged` or
`pr_closed` for tasks that have a `prUrl` (i.e. have an open PR). For tasks
without a PR (e.g. planning tasks, docs), release on terminal status
immediately.

Implementation: in `PATCH /api/workers/[id]`, after writing the terminal
status, call `releasePathClaims(taskId, reason)`. This function:
1. Sets `released_at`, `release_reason` on all active claims for the task.
2. Queries `path_claim_waiters` for those claim IDs.
3. Emits a Pusher event and appends to waiter `instructionHistory` (§5 below).
4. Marks waiters as `notified_at = now()`.

**Orphan/stale claim handling.** If a runner dies without posting a terminal
status, claims remain open. The existing stale-worker reaper (`PATCH
/api/workers/[id]` with `status = 'error'` or the reaper background task)
already stamps a terminal status — `releasePathClaims` is called in that same
code path. No separate stale-claim sweeper is needed.

---

### 5. Pusher Event Schema

**Channel:** `workspace-${workspaceId}` (existing workspace channel)

**Event:** `path-released`

**Payload:**
```jsonc
{
  "taskId": "uuid of the task that released",
  "paths": ["packages/core/db/schema.ts", "apps/web/src/app/api/…"],
  "releasedAt": "2026-08-23T12:34:56.789Z",
  "releaseReason": "pr_merged"
}
```

Workers subscribed to the workspace channel receive this event and can
immediately re-call `check_path_claim` without waiting for their next
`update_progress` poll cycle.

Live workers (subscribed via Pusher) get the real-time event. Queued/pending
tasks receive the notification via their `instructionHistory` on next claim or
update_progress (§send_worker_message delivery).

---

### 6. `send_worker_message` MCP Tool

**Purpose.** Worker-token-level, taskId-addressed, structured messaging between
workers in the same workspace. The primary use case: a blocked worker notifies
the holder it is waiting; the holder can ask a clarifying question; the answer
unblocks it without human intervention.

**Auth level.** Worker token only (same level as `check_path_claim`). Admin and
trigger tokens are excluded. Sender is resolved from the `workerId` context URL
parameter — never accepted as a body parameter. Cross-workspace targeting is
rejected at the route level (data isolation, not a nicety).

**Delivery.** Reuse `workers.instructionHistory` — the same jsonb array that
`/api/workers/[id]/instruct` appends to. On the recipient's next
`PATCH /api/workers/[id]` (update_progress), the response includes any new
`instructionHistory` entries. The MCP tool does NOT build a new inbox — it
appends to the existing one.

**Structured envelope:**
```jsonc
{
  "type": "path_blocked_on_you | path_released | question | answer",
  "fromTaskId": "uuid",
  "fromWorkerId": "uuid",
  "sentAt": "ISO 8601",
  "hopCount": 0,
  "body": { /* type-specific payload */ }
}
```

**Minimum type set:**

| Type | `body` fields | Direction |
|---|---|---|
| `path_blocked_on_you` | `paths: string[]`, `blockedTaskId: string` | blocked → holder |
| `path_released` | `paths: string[]`, `releasedAt: string` | system → waiter |
| `question` | `text: string` | any → any (same workspace) |
| `answer` | `replyToMsgId: string`, `text: string` | any → any |

`path_blocked_on_you` is emitted **automatically** by `check_path_claim` on
409 — the blocked worker does not need to think of it.

`path_released` is emitted by `releasePathClaims` for each registered waiter —
the holder does not need to think of it.

**Rate limiting.** Max 5 messages per sender per minute per recipient task,
enforced in the MCP route via a short-lived counter in the worker row's
`context` jsonb (no new table needed for v1 — the counter expires on each
update_progress write). Exceed limit: 429 with `retryAfter` seconds.

**Message size cap.** `body` serialized to JSON must be ≤ 2 KB. Enforced at
insert time; returns 400 if exceeded.

**Hop cap.** `hopCount` is incremented by the MCP tool on each forward. Max
`hopCount = 5` — a message that has been forwarded 5 times is dropped with a
`429`-equivalent error and a log entry. This prevents ping-pong loops between
two workers escalating questions indefinitely.

**Recipient already terminal.** If the recipient task's status is
`completed | failed | cancelled`, the tool returns:
```jsonc
{ "delivered": false, "reason": "recipient_terminal", "recipientStatus": "completed" }
```
The sender can then escalate to a human via `send_agent_message` (admin) or
simply proceed without the answer.

**Storage.** Messages are stored in `workers.instructionHistory` on the
recipient's currently active worker row (same as human steering messages). If
the recipient has no active worker (task is pending, not yet assigned), the
message is stored in `tasks.context.pendingWorkerMessages: []` and drained into
`instructionHistory` when the worker is created at claim time. Both fields are
already jsonb, so no migration is needed for the storage itself — only for the
new `path_claims` and `path_claim_waiters` tables.

---

### 7. Backward Compatibility for `pathManifest` CAS Logic

`tasks.pathManifest` remains in place and continues to serve two roles:
1. **Declared intent** at task-creation time — fed into the claim route's
   `path_overlap_blocked` deferral gate.
2. **Cached manifest** returned in `check_path_claim` 200 responses, so runners
   can see their full held manifest without joining `path_claims`.

The CAS update in `check_path_claim` (PR #1774 — write to `pathManifest` only
if it hasn't changed) is **preserved** as a secondary write alongside the new
`path_claims` insert. Both writes happen in the same request. If the CAS fails
(concurrent write), the route retries (existing logic).

The claim-route declared-intent check (`siblingTaskManifests`) continues to
read `tasks.pathManifest` for tasks that have not yet called `check_path_claim`
(i.e. tasks that declared a manifest but haven't taken out a held lock). This
catches the common case where a task creator declares intent correctly and the
overlap is detected before any worker runs.

**Migration path.** No data migration for existing `pathManifest` values:
the old column is read-only for overlap detection; new held locks are
`path_claims` rows. Workers running against old code that doesn't write
`path_claims` rows will see no held-lock rows for their claims — the overlap
check degrades gracefully to manifest-only detection (current behaviour).

---

## Failure Modes

**Deadlock (A holds x, waits on y; B holds y, waits on x).** The system does
not prevent this. Detection: if a worker's waiter registration would create a
cycle (A→B→A), reject the registration with a 409 body that names the cycle.
Implementation: before inserting a waiter row, walk the waiter graph
(breadth-first, max depth 8) to check for a cycle through the caller's own
`taskId`. If detected, return:
```jsonc
{ "claimed": false, "deadlock": true, "cycle": ["taskA", "taskB", "taskA"] }
```
Resolution is manual: the worker must report blocked to the organizer.

**A released claim whose PR is still open.** If a task completes but its PR
is not yet merged, claims are NOT released (§Release Triggers). The PR-open
check is: `worker.prUrl IS NOT NULL AND worker.mergedAt IS NULL`. Claims are
held until `pr_merged` or `pr_closed`. A false positive (task completed with
prUrl set but PR already closed via UI before webhook) is handled by the
`pr_closed` webhook path.

**Stale worker dies without terminal status.** The existing reaper posts a
terminal status, which triggers `releasePathClaims`. If the reaper itself is
delayed, claims remain open until the reaper fires. This is acceptable — the
alternative (a separate claim TTL) adds complexity for a rare failure mode.
Monitoring: alert on claims older than 2 × the reaper interval.

**Worker receives `path_released` but loses the re-claim race.** The worker
gets a 409 from its next `check_path_claim`. It is back in the waiter queue if
it re-registers. No special handling needed — the normal 409 flow applies.

---

## Open Questions

1. **Mission-scope rollback.** The PR #1774 missionId filter is proposed for
   removal (workspace is the floor). This may cause false conflicts between
   independent missions editing the same config file. Lean toward: keep
   workspace scope but allow mission owners to opt out via a future
   `sharedPaths` declaration on the mission. Not blocking v1.

2. **Waiter persistence across restarts.** If the API process restarts between
   a release event and fan-out, unnotified waiters remain with `notified_at
   IS NULL`. A recovery sweep on startup (or on first `check_path_claim`) can
   drain these. Not designed here — file a follow-on if observed.

3. **`send_worker_message` for non-path coordination.** The `question/answer`
   types open a general agent-to-agent channel. Risk: scope creep into freeform
   broadcast. Decision: keep `question/answer` types but impose the hop cap and
   rate limits. No freeform broadcast, no group channels.

---

## Non-Goals

- No distributed lock service (no Redis, no Postgres advisory locks, no
  SELECT FOR UPDATE — Neon HTTP driver doesn't support the latter).
- No polling loop for claim release — purely event-driven (Pusher + next
  PATCH response).
- No full agent chat surface — `send_worker_message` carries structured types
  only.
- No automatic re-claim on release — workers must opt in to retry after
  receiving `path_released`.
- No claim TTLs or automatic expiry — release is driven by task lifecycle
  events only.
- No cross-workspace messaging — `send_worker_message` is strictly
  same-workspace.

---

## Implementation Sketch (Phased)

**Phase 1 — Table + migration**
1. Add `path_claims` and `path_claim_waiters` to `packages/core/db/schema.ts`.
2. `bun db:generate` → commit migration files.
3. No behaviour change yet.

**Phase 2 — `check_path_claim` writes claim rows**
1. Update `POST /api/tasks/[id]/path-claim` to read `path_claims` for overlap
   detection and insert rows on success.
2. Update MCP `check_path_claim` tool block accordingly.
3. On 409, insert waiter row + emit `path_blocked_on_you` to holder's
   `instructionHistory`.
4. Remove missionId filter from sibling scope.
5. Tests: claim/release transitions, wildcard no-op, workspace-scope check.

**Phase 3 — Release hooks**
1. Add `releasePathClaims(taskId, reason)` helper in
   `packages/core/path-claims.ts`.
2. Wire into `PATCH /api/workers/[id]` at terminal status write and PR
   lifecycle events.
3. Emit `path-released` Pusher event.
4. Notify waiters via `instructionHistory` append.
5. Tests: fan-out on release, PR-open guard, reaper release path.

**Phase 4 — `send_worker_message` MCP tool**
1. Add tool block to `apps/web/src/app/api/mcp/route.ts` at worker token level.
2. Implement rate limit + hop cap + size cap.
3. Drain `pendingWorkerMessages` from `tasks.context` on worker claim.
4. Tests: auth level, cross-workspace rejection, hop cap, terminal recipient.

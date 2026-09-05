---
title: Human-in-the-Loop Protocol
status: active
owner: max
last_verified: 2026-09-04
summary: Every human answer to an agent MUST either reach a live session or become a durable retry task, and MUST NOT be accepted for a worker that can never act on it, applied twice, or reported as delivered when dropped.
domain: tasks
surfaces: [apps/web/src/app/api/workers/[id]/instruct/route.ts, apps/web/src/app/api/workers/[id]/respond/route.ts, apps/web/src/app/api/workers/[id]/route.ts, apps/runner/src/workers.ts]
related: [mission-task-lifecycle, runner-liveness, mcp-action-contracts]
keywords: [waiting_input, waitingFor, pendingInstructions, instructionHistory, deliveryState, AskUserQuestion, send_agent_message, inputAsRetry, needs_input, worker-needs-input-banner]
verified_by: [apps/web/src/app/api/workers/[id]/instruct/route.test.ts, apps/web/src/app/api/workers/[id]/respond/route.test.ts, packages/core/__tests__/mcp-tools-send-agent-message.test.ts, apps/web/src/app/api/workers/[id]/route.test.ts, apps/web/src/app/api/workers/[id]/interrupt/route.test.ts, apps/web/src/app/api/tasks/[id]/approve-plan/route.test.ts, apps/runner/__tests__/unit/worker-manager-state.test.ts]
supersedes: []
---
# Human-in-the-Loop Protocol

**Capability statement**: When an agent needs a person, the coordination layer
MUST make the question visible with an actionable link, accept an answer only
from a caller authorised for that worker's workspace, and land that answer either
in the live session or in a durable task row — never in a place from which no
resumption is possible.

`docs/specs/mission-task-lifecycle.md` defines the states (`waiting_input`,
`waitingFor`, the terminal-worker guard). This spec defines the **interaction**:
who may answer, what an answer does to the session, and what happens to an
answer whose worker is gone.

---

## The two answer channels

There are two mechanically different ways an answer reaches an agent, with
different durability. Confusing them is the source of most reported "the agent
ignored my answer" incidents.

| | Channel A — retry | Channel B — steering |
|---|---|---|
| Endpoint | `POST /api/workers/[id]/respond` | `POST /api/workers/[id]/instruct` |
| UI entry | needs-input banner, `/app/tasks/[id]/respond` | instruct form, `TaskQuestionFeed` reply |
| MCP entry | none | `send_agent_message` (admin) |
| Precondition | `workers.waitingFor` is non-null — **any** status | worker status not `completed`/`failed` |
| Effect | new `pending` task; old worker `superseded` | message queued or pushed to the same session |
| Durability | a DB row; survives a dead runner | at-most-once; no acknowledgement |
| Session continuity | new session, `baseBranch` = old branch | same session, same context window |

Channel A is the dashboard default. `deriveTaskPhase`'s `waiting_input` phase is
documented in `apps/web/src/lib/task-presentation.ts` as "a worker asked a
question — answering spawns a new worker", and that is literal.

---

## Asking: how a worker enters `waiting_input`

**Invariants**:
- The only way a worker row reaches `waiting_input` is a runner `PATCH
  /api/workers/[id]` carrying `status: 'waiting_input'`; `waitingFor` is written
  from the same payload and is reduced to `{ type }` alone when the workspace's
  `dataClass` is `sensitive`.
- A `waitingFor.type === 'question'` payload MUST produce a human notification
  carrying a deep link to `/app/tasks/<taskId>/respond` — the question is
  useless if the only place it renders is a dashboard nobody is looking at.
- `waitingFor` MUST be cleared to `null` when the worker reports `running` and
  the payload does not restate it.
- The transition broadcasts `WORKER_PROGRESS` (not a dedicated event) on both
  the worker and workspace channels, so any surface that wants to react to
  "needs input" MUST read `status` from the payload rather than switch on the
  event name.
- **`waiting_input` does not imply a live session.** In the runner's default
  mode (`inputAsRetry !== false`) an `AskUserQuestion` tool call is terminal for
  the session: the runner awaits the `waiting_input` sync, then aborts the
  subprocess. The post-loop cleanup PATCH keeps `status: 'waiting_input'`
  (carrying `error: 'needs_input: …'` for observability) rather than dropping
  to `failed` — a parked question is not a crash. Reporting it as `failed` here
  used to feed the server's generic mission auto-retry gate (blind
  re-dispatch into the same unanswered question before any human saw it) and
  the failure-analytics / success-rate-by-role aggregates, and hid the task
  behind `deriveTaskPhase`'s failed-wins-over-waiting_input precedence
  (`apps/web/src/lib/task-presentation.ts`) instead of its dedicated
  `waiting_input` phase — see the 4164ff29 incident. Every surface that offers
  an answer affordance still keys on `waitingFor` rather than on a live
  status — `RealTimeWorkerView` renders `worker-needs-input-banner` from
  `worker.waitingFor` alone, which now agrees with `status` instead of
  compensating for it.

**Acceptance criteria**:
- AC-HITL-1: GIVEN a runner PATCH with `status: 'waiting_input'` and
  `waitingFor: { type: 'question', prompt, options }` WHEN the row is written
  THEN `GET /api/tasks/waiting-input` returns that task with its `waitingFor`
  and an `actionUrl` ending `/respond`.
- AC-HITL-2: GIVEN a `sensitive` workspace WHEN the same PATCH is received THEN
  the stored `waitingFor` contains `type` only and the notification body carries
  no prompt prose.
- AC-HITL-3: GIVEN a worker in `waiting_input` WHEN a PATCH with
  `status: 'running'` and no `waitingFor` key arrives THEN `waitingFor` is set
  to `null` in the same update.

**Code surface**:
- `apps/web/src/app/api/workers/[id]/route.ts:450` (persist + redact),
  `:456` (notify with respond link), `:470` (auto-clear on resume)
- `apps/runner/src/workers.ts:4265` (`AskUserQuestion` handling), `:3215`
  (`inputAsRetry` abort branch — post-loop cleanup, parks as `waiting_input`)
- `apps/web/src/app/api/tasks/waiting-input/route.ts`
- `apps/web/src/app/app/(protected)/tasks/[id]/RealTimeWorkerView.tsx:331`
  (`worker-needs-input-banner`), fixtures at
  `apps/web/src/app/app/dev/fixtures/fixtures-data.ts`

---

## Channel A — `/respond`: the durable answer

**Invariants**:
- `/respond` MUST be status-agnostic. It gates on `worker.waitingFor` being
  non-null and on nothing else; a worker in `error`, `failed` or `waiting_input`
  all accept an answer. This is not laxity — it is the contract that keeps the
  `inputAsRetry` abort (above) from swallowing the question.
- An accepted answer MUST produce one new `pending` task titled
  `Continue: <original title>` whose description carries the original task, the
  recorded milestones, the question and the human answer verbatim, and whose
  `context` carries `baseBranch` (the dead worker's branch), `userInput`,
  `previousAttempt.workerId` and `iteration + 1`. Branch continuity is what
  makes the answer resumable rather than a restart.
- The answering worker MUST be marked `superseded` (not `completed`, not
  `failed`) with `waitingFor = null` — it did not finish its task, it was
  replaced by the continuation task, so it must not count as either a success
  or a failure. `superseded` is included in `IN_FLIGHT_WORKER_STATUSES`
  (`apps/web/src/lib/failure-analytics.ts`) so it is excluded from both the
  success and failure buckets of `get_failure_analytics` /
  success-rate-by-role, and in `TERMINAL_WORKER_STATUSES`
  (`apps/web/src/app/api/workers/[id]/route.ts`) so a late runner PATCH for the
  same worker is rejected (409) rather than resurrecting or overwriting it.
- The continuation task MUST inherit the fields that describe what the work
  must deliver — `mode`, `taskClass`, `priority`, `outputRequirement`,
  `outputSchema`, `category`, `pathManifest`, `backend` — since none of those
  change because a question was asked. It MUST NOT inherit `dependsOn` (the
  parent's prerequisites were already satisfied before the parent could run),
  `subjectAnchor` (drives a dedup/supersession subsystem this path is not
  part of), or `creationSource` (this row was created by whoever answered the
  question via this route, not by the orchestrator — it always defaults to
  `'api'` here). Copying `mode: 'planning'` is safe because the
  planning-contract guard's `mode === 'planning'` clause fires unconditionally
  on mode alone; it does not depend on `creationSource` or `scheduleId` (those
  only gate the guard's separate orchestrator-fallback clause — see the
  `mode`/`creationSource` distinction in the guard's own comment,
  `apps/web/src/app/api/workers/[id]/route.ts`).
- `context.baseBranch` is honoured by the runner's worktree setup only when
  that branch already exists on the remote — i.e. the original worker had
  already pushed (for example, a PR was already open). If the question was
  asked before anything was pushed, the runner falls back to a fresh worktree
  from the default branch; the server cannot detect at `/respond` time which
  case applies, so "resumes the existing work" is not a guarantee.
- An answer for a worker with no `waitingFor` MUST be refused with HTTP 400. This
  refusal is the only defence against a second person answering the same prompt.
- Authorisation: a session user with workspace access, or an API key whose
  account **owns the worker** (`workers.accountId`). A key for another account
  gets 403, not 404 — the worker exists, the caller may not act on it.
- Known residual race: this route's claim write and an in-flight runner PATCH
  for the same worker use independent, uncoordinated CAS predicates (this one
  gates on `waitingFor`; the PATCH route's terminal-transition reservation
  gates on `status`). A worker read fresh after this commits is correctly
  rejected as terminal; a runner PATCH already mid-flight when this commits can
  still land after it and overwrite `status`. Closing this fully needs a shared
  reservation primitive between the two routes — not implemented here, because
  the alternative (gating this claim on worker status) would break the
  deliberate contract above that `error`/`failed` with `waitingFor` set must
  still be accepted.

**Acceptance criteria**:
- AC-HITL-4: GIVEN a worker with `status: 'failed'`, `error: 'needs_input: …'`
  and `waitingFor` set WHEN `POST /respond` is called THEN HTTP 200 with a new
  `taskId`; the answer is NOT lost to the worker's terminal status.
- AC-HITL-5: GIVEN a worker whose `waitingFor` is `null` WHEN `POST /respond` is
  called THEN HTTP 400 `Worker is not waiting for input` and no task is created.
- AC-HITL-6: GIVEN an API key whose account differs from `workers.accountId`
  WHEN `POST /respond` is called THEN HTTP 403 and no task is created.
- AC-HITL-7: GIVEN a successful `/respond` THEN the new task's
  `context.baseBranch` equals the answered worker's `branch` and
  `context.iteration` is the previous iteration + 1.
- AC-HITL-29: GIVEN a successful `/respond` THEN the answered worker's `status`
  is `superseded`, never `completed`.
- AC-HITL-30: GIVEN a parent task with `priority`, `outputRequirement`,
  `outputSchema`, `category`, `pathManifest`, `backend` set WHEN `/respond`
  creates the continuation THEN all six are copied onto it, and `dependsOn`,
  `subjectAnchor`, `creationSource` are NOT copied.
- AC-HITL-31: GIVEN a task with `mode: 'execution'`, `creationSource:
  'orchestrator'`, `scheduleId: null` (an auto-approved mission builder child
  from `approve-plan.ts`, not a cron-dispatched organizer cycle) WHEN its
  worker completes with a prose summary and no `structuredOutput` THEN the
  planning-contract guard in `apps/web/src/app/api/workers/[id]/route.ts`
  MUST NOT override it to `failed` — `scheduleId` (populated only by the cron
  dispatcher) is the guard's orchestrator-fallback discriminator, not
  `creationSource` alone, precisely because `approve-plan.ts` stamps every
  auto-approved builder child with `creationSource: 'orchestrator'` too
  (PR #2076).

**Code surface**:
- `apps/web/src/app/api/workers/[id]/respond/route.ts:49` (the `waitingFor`
  gate), `:93` (retry task), `:120` (supersede the worker)
- Client entries: `apps/web/src/app/app/(protected)/tasks/[id]/respond/RespondForm.tsx`,
  `apps/web/src/app/app/(protected)/tasks/[id]/RealTimeWorkerView.tsx:130`

---

## Channel B — `/instruct`: steering a live session

**Invariants**:
- A message MUST be refused (HTTP 400) for a `completed` or `failed` worker. A
  live-session channel that accepts messages for the dead is a silent drop.
- Exactly one transport per message, never both: `priority: 'urgent'` fires
  `WORKER_COMMAND` `{ action: 'message' }` on the worker channel and leaves
  `pendingInstructions` null; anything else writes `pendingInstructions` and
  fires no Pusher event. Sending both delivered the same instruction twice (once
  by push, once on the next sync) and produced duplicate milestones — PR #307.
- `pendingInstructions` is a single `text` column, not a queue. A second
  non-urgent message that arrives before the first is drained REPLACES it.
- Every message MUST be appended to `instructionHistory` with a
  `deliveryState`, capped at 30 entries; a `sensitive` workspace stores
  `{ type, timestamp, deliveryState }` and drops the text.
- Queued delivery is at-most-once and unacknowledged: the next non-terminal
  PATCH returns the text in `instructions` and nulls `pendingInstructions` in
  the same guarded UPDATE, and flips the LAST `pending` history entry to
  `delivered` via `lastIndexOf`. `deliveryState: 'delivered'` therefore records
  what the server did, NOT that any agent read it.
- The runner MUST apply an instruction as a user message on the existing
  session, linked to the pending tool call when one exists
  (`buildUserMessage` with `parentToolUseId`), so an answer to `AskUserQuestion`
  resolves that tool call instead of starting an unrelated turn.
- Delivering a message MUST NOT kill the session it steers. A resumed session
  passes `resume` and MUST NOT also pass `sessionId` — the CLI rejects the pair
  without `--fork-session`, which turned every steering message on a resumed
  worker into a crash (PR #1794).
- Authorisation: a session user with workspace access, OR an admin-level API
  token. The admin-token branch performs **no** workspace check, so an
  admin key can steer any worker in any team; a non-admin key gets 401 even for
  its own workers. `send_agent_message` mirrors this by being an `adminActions`
  entry.
- `send_agent_message` MUST resolve the target by **worker** status, never task
  status (`tasks.status` stays `assigned` for the whole run), and MUST pick the
  newest non-terminal worker — `GET /api/tasks/[id]?include=workers` orders
  `desc(createdAt)`. With no non-terminal worker it MUST fail loudly and
  distinguish "still pending, never claimed" from "all workers terminal".

**Acceptance criteria**:
- AC-HITL-8: GIVEN a `running` worker WHEN `POST /instruct` is called with
  `priority: 'urgent'` THEN `triggerEvent` is called exactly once with the
  worker channel and `worker:command`, AND the written `pendingInstructions` is
  null AND the new history entry reads `deliveryState: 'delivered'`.
- AC-HITL-9: GIVEN the same worker WHEN `POST /instruct` is called with no
  priority THEN no Pusher event is emitted, `pendingInstructions` holds the
  message and the history entry reads `deliveryState: 'pending'`.
- AC-HITL-10: GIVEN a worker with `status: 'completed'` WHEN `POST /instruct` is
  called THEN HTTP 400 `Cannot instruct completed or failed workers` and no row
  is written.
- AC-HITL-11: GIVEN a worker with `pendingInstructions` set WHEN the runner
  PATCHes any non-terminal status THEN the response `instructions` equals that
  text and the column is nulled in the same write.
- AC-HITL-12: GIVEN a task whose only workers are `completed`/`failed` WHEN
  `send_agent_message` is called THEN it throws naming "no active worker" and
  never calls `/instruct`.
- AC-HITL-13: GIVEN a `sensitive` workspace WHEN `POST /instruct` is called THEN
  the stored history entry has no `message` field.

**Code surface**:
- `apps/web/src/app/api/workers/[id]/instruct/route.ts:26` (admin token),
  `:53` (terminal refusal), `:81` (history + `deliveryState`), `:97`
  (single-transport write), `:104` (urgent push)
- Drain + delivery: `apps/web/src/app/api/workers/[id]/route.ts:2017`,
  `:2043` (`finalWriteGuard`), `:2307` (`instructions` in the response)
- Runner: `apps/runner/src/worker-sync.ts:278` (apply on sync),
  `apps/runner/src/pusher-manager.ts:274` (apply on push),
  `apps/runner/src/workers.ts:4429` (`sendMessage`, resume vs enqueue),
  `apps/runner/src/recovery.ts:414` (`resumeSession`, two-layer fallback)
- MCP: `packages/core/mcp-tools.ts:3891` (`send_agent_message`), `:3902`
  (worker-status liveness resolution)
- Read model: `apps/web/src/app/api/tasks/[id]/messages/route.ts` and the
  `get_task_messages` action, both of which read `instructionHistory` of the
  newest worker and flag entries still `pending` as undelivered.

---

## Who may answer

| Endpoint | Session user | API key | Extra gate |
|---|---|---|---|
| `POST /workers/[id]/respond` | workspace access | account owns the worker | none |
| `POST /workers/[id]/instruct` | workspace access | **admin level only**, no workspace check | rejects terminal workers |
| `POST /workers/[id]/cmd` | workspace access | account owns the worker | action in `pause,resume,abort,message,recover` |
| `POST /workers/[id]/recover` | workspace access | account owns the worker | mode in `diagnose,complete,restart` |
| `POST /workers/[id]/interrupt` | workspace access | **refused** | reviewer task only; `Content-Type: application/json` |
| `POST /tasks/[id]/approve-plan` / `reject-plan` | workspace access | workspace access | planning task, `completed` |
| `POST /tasks/[id]/notes/[noteId]/reply` | workspace access | workspace access | note is task-scoped |
| `GET /tasks/waiting-input` | workspace access | **refused** | — |

**Invariants**:
- No interaction endpoint is anonymous: each resolves `getCurrentUser` or
  `authenticateApiKey` and then re-checks scope with `verifyWorkspaceAccess`,
  `verifyAccountWorkspaceAccess`, `getUserWorkspaceIds`, or an `accountId`
  equality — presenting a valid credential for a different tenant is never
  enough.
- `/interrupt` MUST reject a request whose `Content-Type` is not
  `application/json` (HTTP 415), so a cross-origin HTML form cannot trigger a
  takeover; the same protection is not claimed for the other endpoints.
- The HTTP route is the authorisation boundary. An MCP action's level
  (`send_agent_message`, `approve_plan`, `reject_plan` are `adminActions`) is an
  ADDITIONAL restriction on agents, never the only one — the route must hold on
  its own.

**Acceptance criteria**:
- AC-HITL-14: GIVEN a non-admin API key WHEN `POST /instruct` is called THEN
  HTTP 401 naming the admin-level requirement.
- AC-HITL-15: GIVEN an authenticated session user with no membership in the
  worker's workspace WHEN `POST /instruct` or `POST /respond` is called THEN
  HTTP 404 (existence is not disclosed).
- AC-HITL-16: GIVEN a form-encoded `POST /interrupt` THEN HTTP 415 and no
  worker row is written.

**Code surface**:
- `apps/web/src/lib/auth-helpers.ts`, `apps/web/src/lib/api-auth.ts`,
  `apps/web/src/lib/team-access.ts`
- `apps/web/src/app/api/workers/[id]/interrupt/route.ts:29` (content-type
  gate), `:60` (workspace check)
- `packages/core/mcp-tools.ts:171` (`adminActions`)

---

## Takeover: interrupt, recover, cmd

**Invariants**:
- `/interrupt` is the only interaction write in this protocol that takes an
  optimistic lease: it terminates the worker with
  `UPDATE … WHERE id = ? AND status = <status it read>` and, on a 0-row result,
  returns HTTP 409 and performs NO downstream effect. Completion and takeover
  race for one lease and only the winner may fail the task, post the
  `reviewer_escalated` note, and broadcast.
- `/interrupt` is restricted to reviewer workers (`tasks.category === 'review'`)
  and returns 409 for an already-terminal worker: an interrupt with no effect
  MUST NOT report success.
- `cancelQueued` is a best-effort Pusher hint sent AFTER the lease is won; the
  DB outcome MUST NOT depend on it.
- `/recover` is a Pusher-only command (`WORKER_COMMAND` `{ action: 'recover' }`)
  and reaches nothing if no runner is subscribed. It sets `status: 'running'`
  and clears `error` unconditionally, with no compare-and-swap and none of the
  PATCH route's `reactivatingTerminalWorker` protections, so a recover on a dead
  runner leaves a row that merely looks alive until `cleanupStaleWorkers` reaps
  it again.
- `/cmd` performs no state check and writes no row: a `message` sent through it
  is invisible to `instructionHistory`, and therefore to
  `/api/tasks/[id]/messages` and `get_task_messages`. Any surface that presents
  instruction history as the record of human input is incomplete by exactly this
  path.

**Acceptance criteria**:
- AC-HITL-17: GIVEN a live reviewer worker whose status changes between the read
  and the write WHEN `POST /interrupt` runs THEN HTTP 409, the task is NOT
  failed, and no `reviewer_escalated` note is inserted.
- AC-HITL-18: GIVEN a worker on a non-reviewer task WHEN `POST /interrupt` is
  called THEN HTTP 400 and the worker is untouched.
- AC-HITL-19: GIVEN `cancelQueued: true` on a successful interrupt THEN a
  `worker:command` `{ action: 'abort', cancelQueued: true }` event is emitted on
  the worker channel; GIVEN the flag absent THEN no worker-channel event is
  emitted.
- AC-HITL-20: GIVEN `POST /recover` with an invalid mode THEN HTTP 400 and no
  Pusher command is sent.

**Code surface**:
- `apps/web/src/app/api/workers/[id]/interrupt/route.ts:88` (the CAS), `:110`
  (`cancelQueued`), `:127` (escalation note)
- `apps/web/src/app/api/workers/[id]/recover/route.ts:68`
- `apps/web/src/app/api/workers/[id]/cmd/route.ts:52`
- Runner handlers: `apps/runner/src/pusher-manager.ts:263` (abort guard), `:285`
  (recover)

---

## Plan approval and rejection

**Invariants**:
- `/approve-plan` and `/reject-plan` MUST both require `tasks.mode ===
  'planning'` AND `tasks.status === 'completed'`, rejecting anything else with
  HTTP 400: there is no plan to judge before the planner finishes.
- Approval MUST be idempotent-by-refusal: `approvePlan` looks for any task whose
  `parentTaskId` is the planning task and throws, surfaced as HTTP 409 `Plan
  already approved`. This is the only guard against two approvers.
- A plan with a dependency cycle MUST be rejected (HTTP 400) before any child
  task is created — `detectCircularDeps` runs before the first insert.
- Child tasks MUST inherit the planning task's `workspaceId` and `missionId`, and
  `dependsOn` refs MUST be resolved to real task ids in a second pass.
- **Human approval is an override, not a gate.** `resolveCompletedTask`
  auto-approves the plan of EVERY completed planning task with
  `{ autoApproved: true }`. The dashboard's review panel therefore races the
  auto-approver, and its expected outcome for a plan that already landed is the
  409 above. No surface may describe plan approval as a required human step.
- Rejection does not invalidate the plan. `/reject-plan` mutates nothing on the
  original task; it inserts a new `planning` task carrying
  `context.planFeedback` and `context.previousPlanTaskId`. The rejected plan
  keeps its own approvability.

**Acceptance criteria**:
- AC-HITL-21: GIVEN a planning task that already has child tasks WHEN
  `POST /approve-plan` is called THEN HTTP 409 `Plan already approved` and no
  additional task is created.
- AC-HITL-22: GIVEN a plan whose steps form a cycle WHEN `POST /approve-plan` is
  called THEN HTTP 400 naming the cycle and ZERO child tasks exist afterwards.
- AC-HITL-23: GIVEN a planning task with `status: 'in_progress'` WHEN either
  endpoint is called THEN HTTP 400 `Planning task has not completed yet`.
- AC-HITL-24: GIVEN `POST /reject-plan` with no `feedback` THEN HTTP 400 and no
  revised task is created.

**Code surface**:
- `apps/web/src/app/api/tasks/[id]/approve-plan/route.ts:46`,
  `apps/web/src/app/api/tasks/[id]/reject-plan/route.ts:45`
- `apps/web/src/lib/approve-plan.ts:52` (duplicate guard), `:62`
  (`detectCircularDeps`), `:104` (ref resolution)
- Auto-approval: `apps/web/src/lib/task-dependencies.ts:77`
- UI: `apps/web/src/app/app/(protected)/tasks/[id]/PlanReviewPanel.tsx`
- MCP: `packages/core/mcp-tools.ts:2998` (`approve_plan`), `:3027`
  (`reject_plan`)

---

## A waiting worker's clock (interaction with `runner-liveness`)

An unanswered question is the one legitimate reason a worker is idle, so the
liveness machinery deliberately does not treat it as a fault. The consequence is
that `waiting_input` has its own, much slower clock — and holds resources until
it fires.

**Invariants**:
- `isStaleWorker` returns `false` for anything that is not `running`, so a
  `waiting_input` worker MUST NOT be rendered as stale however long it waits.
- `cleanupStaleWorkers`' per-worker rules cover `running`/`starting`/`idle` and
  the silent-start case only. `waiting_input` appears there solely in
  `LIVE_WORKER_STATUSES` — as a reason NOT to reset a task that has another live
  worker — and in the runner-offline sweep, which additionally requires
  `updatedAt` older than `HEARTBEAT_STALE_MS`. The runner re-syncs every waiting
  worker on its 10s cycle, so while the runner lives that condition is never met.
- The only clock that ends an unanswered question is therefore
  `cleanupStuckWaitingInput`: `WAITING_INPUT_MISSION_STALE_MS` (4h) for a mission
  task, `WAITING_INPUT_STALE_MS` (24h) otherwise. It is account-agnostic (a
  global sweep, unlike `cleanupStaleWorkers`), is reachable only through
  `POST /api/tasks/cleanup`, and no entry in `cron-manifest.json` calls that
  route — it is driven by each runner's 30-minute cleanup timer, which needs a
  session or admin-level token to succeed.
- The timeout MUST fail the worker, fail the original task, and create ONE retry
  task whose description ends with a directive not to ask for user input,
  carrying `baseBranch` and an incremented `iteration`; it MUST release the OAuth
  concurrency seat. The unanswered question is preserved as prose in the retry
  description — it is not carried as a pending answer.
- Until answered or timed out, a `waiting_input` worker holds its concurrency
  seat and its path claims. This is the mechanism behind the `advisory_manifest`
  soft deferral described in `docs/specs/mission-task-lifecycle.md`: a peer task
  can be blocked for hours by a question nobody has seen.

**Acceptance criteria**:
- AC-HITL-25: GIVEN a `waiting_input` worker with `updatedAt` two hours old WHEN
  `isStaleWorker` is evaluated for display THEN it returns `false`.
- AC-HITL-26: GIVEN a `waiting_input` worker on a mission task older than 4h
  WHEN `cleanupStuckWaitingInput` runs THEN the worker is `failed`, the task is
  `failed`, and exactly one retry task exists whose description contains
  "Do NOT ask for user input".
- AC-HITL-27: GIVEN the same worker on a standalone task at 5h WHEN
  `cleanupStuckWaitingInput` runs THEN nothing is changed (the 24h threshold
  applies).
- AC-HITL-28: GIVEN a reaped `waiting_input` worker on an OAuth account THEN
  `accounts.activeSessions` is decremented exactly once for that worker.

**Code surface**:
- `apps/web/src/lib/task-presentation.ts:148` (`isStaleWorker`), `:39`
  (`LIVE_WORKER_STATUSES`)
- `apps/web/src/lib/stale-workers.ts:32` (`WAITING_INPUT_STALE_MS`), `:35`
  (`WAITING_INPUT_MISSION_STALE_MS`), `:592` (`cleanupStuckWaitingInput`),
  `:416` (runner-offline sweep)
- `apps/web/src/app/api/tasks/cleanup/route.ts:230`
- `apps/runner/src/workers.ts:495` (10s sync), `:498` (30-min cleanup),
  `apps/runner/src/worker-sync.ts:302` (waiting workers always re-synced)
- `cron-manifest.json` — no entry for `/api/tasks/cleanup`

---

## Out of scope

- **Agent-to-agent messaging**: `send_worker_message` and the
  `tasks.context.pendingWorkerMessages` drain in the worker PATCH. Same plumbing,
  no human in the loop.
- **Permission prompts**: `waitingFor.type === 'permission'` is resolved
  locally by the runner's debug UI through `resolvePermission`; it never reaches
  the coordination API as an answerable prompt.
- **Reviewer agents**: automated approve / request-changes / escalate outcomes.
  Only the human takeover of a reviewer (`/interrupt`) is specified here.
- **Mission completion overrides** and the goal-criteria gate — see
  `docs/specs/mission-task-lifecycle.md`.
- **Notification transport** and per-team channel configuration. This spec
  requires only that a question produce a notification carrying the respond
  link.
- **The runner's local debug UI** endpoints on port 8766, which can drive
  `sendMessage` without any coordination-layer record.

---

## Verification gaps

Each item is a claim this spec deliberately does NOT make as an invariant,
because the code does not enforce it. They are the falsifiable list of things to
fix or to test.

1. **An urgent answer can be lost with no trace but a lie.** `/instruct` with
   `priority: 'urgent'` writes `deliveryState: 'delivered'` and stores nothing.
   `triggerEvent` is not acknowledged; `pusher-manager.ts:274` and
   `worker-sync.ts:278` both discard the boolean `sendMessage` returns. If the
   runner is offline, mid-restart, or the worker is not in a state that accepts a
   message, the answer is gone and the history says it was delivered. No test
   asserts a retry or a re-queue, because there is none.
2. **A queued answer can be overwritten.** `pendingInstructions` is one `text`
   column: two non-urgent messages before a sync and the first is lost. Only the
   LAST `pending` history entry is flipped to `delivered` (`lastIndexOf`), so the
   dropped one stays `pending` forever — that stale `pending` is the only signal,
   and it is indistinguishable from "not yet checked in".
3. **`/respond` has no compare-and-swap.** Two people (or a double-submitting
   client) answering concurrently both read `waitingFor` as set and both create a
   `Continue:` task on the same branch. `/interrupt` demonstrates the guard
   (`WHERE status = <read status>`) that `/respond` lacks. Untested.
4. **An answer after reassignment is accepted.** `/api/tasks/[id]/reassign` fails
   active workers with `error: 'Task was reassigned'` but does not clear
   `waitingFor`, so the banner still renders and `/respond` still accepts —
   spawning a `Continue:` task on the old branch while the reassigned task is
   being re-claimed. Compounding it, `'Task was reassigned'` is absent from the
   PATCH route's non-reactivatable error list, so the superseded worker can still
   be reactivated with `reactivate: true`.
5. **`/instruct`'s terminal set is narrower than the PATCH route's.** The route
   refuses only `completed` and `failed`; `TERMINAL_WORKER_STATUSES` in
   `apps/web/src/app/api/workers/[id]/route.ts:59` also contains `error`, and
   `finalWriteGuard` blocks writes to such rows. A message accepted for an
   `error` worker can never be drained. `send_agent_message` shares the defect —
   its liveness filter excludes only `completed`/`failed`, so it will select an
   `error` worker as active.
6. **Mission-note replies have no delivered marker.** The note-delivery block
   re-selects every `user` reply to an `answered` question owned by this worker on
   EVERY non-terminal PATCH, and `mission_notes` has no delivered-at column, so
   the same human reply is re-injected into the session on each 10s sync. `type:
   'guidance'` notes with `status: 'open'` repeat the same way.
7. **Task-scoped question replies are never delivered by the server.**
   `/api/tasks/[id]/notes/[noteId]/reply` accepts only notes with `missionId IS
   NULL`, while the PATCH delivery block requires the task to HAVE a `missionId`.
   `TaskQuestionFeed` — which renders only for non-mission tasks — papers over
   this by also POSTing an urgent `/instruct` when a live worker happens to
   exist. With no live worker the reply is recorded and delivered to no one.
8. **The needs-input notification has no dedupe and no transition guard.**
   `route.ts:456` fires on any PATCH whose payload carries
   `waitingFor.type === 'question'`, and `worker-sync.ts:215` restates
   `waitingFor` on every 10s sync while waiting. `notify` has no dedupe key.
9. **`/recover` can resurrect anything.** No compare-and-swap, and none of the
   PATCH route's protections against reviving a server-expired worker; it writes
   `status: 'running'` first and only then pushes a command that may reach
   nobody. `runner-liveness` already lists the Pusher recovery path as out of
   scope; this endpoint is the human-facing half of the same unguarded path.
10. **`/cmd` messages are unaudited.** A human message sent via
    `{ action: 'message' }` bypasses `instructionHistory` entirely, so the
    task's message list and `get_task_messages` under-report human input.
11. **Approve-after-reject is accepted.** `/reject-plan` records nothing on the
    original task, so approving the rejected plan later succeeds whenever the
    duplicate-child guard happens not to fire.
12. **The `waiting_input` timeout depends on an undeclared trigger.**
    `cleanupStuckWaitingInput` runs only via `POST /api/tasks/cleanup`, which no
    cron declares; it rides each runner's 30-minute timer and needs a session or
    admin-level token, and the runner swallows the failure with a warning. If
    every runner for a team is down — the case where a parked question matters
    most — nothing fires it.
13. **No test covers the cross-channel invariant** that a question answered
    through Channel A cannot also be answered through Channel B (or the reverse):
    `/respond` completes the worker while `/instruct` would have steered it, and
    nothing links the two records.

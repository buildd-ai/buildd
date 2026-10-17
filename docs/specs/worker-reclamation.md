---
title: Worker Reclamation
status: active
owner: max
last_verified: 2026-10-17
summary: Silent workers MUST be reclaimed with the correct timeout, exit cause and retry treatment.
domain: runners
surfaces: [apps/web/src/lib/stale-workers.ts, apps/web/src/lib/lost-claim.ts, apps/web/src/lib/sessionless-worker-settle.ts]
related: [runner-heartbeat, runner-failure-alerts]
verified_by: [apps/web/src/lib/stale-workers.test.ts, apps/web/src/lib/sessionless-worker-settle.test.ts, apps/web/src/app/api/cron/waiting-input-sweep/route.test.ts, apps/web/src/lib/worker-exit-taxonomy.test.ts, apps/web/src/lib/lost-claim.test.ts, apps/runner/__tests__/unit/claim-handoff.test.ts]
assertions:
  - id: extra-guard-1
    type: test_file
    path: apps/web/src/lib/lost-claim.test.ts
  - id: extra-guard-2
    type: test_file
    path: apps/runner/__tests__/unit/claim-handoff.test.ts
  - id: cleanup-stale-workers
    type: symbol
    name: cleanupStaleWorkers
    path: apps/web/src/lib/stale-workers.ts
  - id: cleanup-stuck-waiting-input
    type: symbol
    name: cleanupStuckWaitingInput
    path: apps/web/src/lib/stale-workers.ts
  - id: release-unacknowledged-claims
    type: symbol
    name: releaseUnacknowledgedClaims
    path: apps/web/src/lib/lost-claim.ts
  - id: guard-1
    type: test_file
    path: apps/web/src/lib/stale-workers.test.ts
  - id: guard-2
    type: test_file
    path: apps/web/src/lib/worker-exit-taxonomy.test.ts
---
# Worker Reclamation

**Capability statement**: Silent workers MUST be reclaimed with the correct timeout, exit cause and retry treatment.

## Stale Worker Detection (per-worker timeout)

**Invariants**:
- A worker in `running` or `starting` status with no `updatedAt` change for
  **35 minutes** (`WORKER_STALE_REAP_MS`: the runner's own backstop
  `WORKER_HARD_TIMEOUT_MS`, 30 minutes, plus `WORKER_STALE_REAP_GRACE_MS`,
  5 minutes) is stale. The threshold MUST stay above the runner's backstop:
  `updatedAt` only moves when the runner syncs a state change, so a shorter
  server threshold kills healthy workers inside long silent tool calls, and
  the runner's own, more specific error would be overwritten. A run the cloud
  agent parked after a restart (`notParkedScope`) is not stale while parked.
- A started worker with at most `SILENT_START_MAX_TURNS` turns, no tokens and
  no spend, and no `updatedAt` change for **10 minutes**, is a silent start:
  the session died before its first real turn. It is reaped with
  `SILENT_START_ERROR` before the generic rule would notice it.
- A worker in `idle` status with no `updatedAt` change for **5 minutes** is
  stale (runners that crash before starting the agent).
- Stale detection runs during `POST /api/workers/claim` (synchronously) and MAY
  also run from a periodic cron endpoint.
- Detection is scoped to the claiming `accountId` — only that account's workers
  are cleaned up — with ONE deliberate exception below.
- **Never-started rows are team-scoped, not account-scoped.** A worker row in
  `idle` status with `startedAt IS NULL` past the idle threshold MUST be
  reapable by any account in the same team (`accounts.team_id`), not only by the
  account that claimed it. Rationale: the claim route mints such a row before
  handing it to the runner, and the claim insert refuses a re-claim while any
  row for the task is in (`idle`, `running`, `starting`, `waiting_input`). If
  only the dead runner's own account may clear it, the task is blocked
  permanently rather than for the idle threshold, and the row keeps pinning a
  concurrency seat. `startedAt IS NULL` is what makes this safe to cross the
  account boundary: no session ever began, so nothing live is interrupted, and
  the row is booked `never_started`, which does not consume a retry attempt.
- The plain `idle` rule (which does NOT require `startedAt IS NULL`) and the
  generic and silent-start rules MUST stay account-scoped.
- When a reaped batch spans accounts, the `accounts.activeSessions` decrement
  MUST be grouped by each reaped row's own `accountId`. Charging the batch to
  the cleaning account is a seat leak in both directions.

**Acceptance criteria**:
- AC-4: GIVEN a worker in `running` status with `updatedAt` older than
  `WORKER_STALE_REAP_MS` (35 minutes) WHEN `cleanupStaleWorkers` runs THEN the
  worker status transitions to `failed` with `STALE_EXPIRED_ERROR`; GIVEN one
  last updated 20 minutes ago THEN it is left untouched.
- AC-5: GIVEN an `idle` worker with `updatedAt` > 5 minutes ago WHEN
  `cleanupStaleWorkers` runs THEN the worker is marked `failed`.
- AC-30: GIVEN an `idle` worker with `startedAt IS NULL` past the idle threshold
  belonging to account A WHEN `cleanupStaleWorkers(B)` runs for a different
  account B in the SAME team THEN the worker is marked `failed` with
  `exitCause: 'never_started'`, and `activeSessions` is decremented on account
  A, not on account B.
- AC-31: GIVEN the same row WHEN `cleanupStaleWorkers` runs for an account in a
  DIFFERENT team THEN the worker is left untouched.
- AC-6: GIVEN a stale worker whose task has another active worker WHEN cleanup
  runs THEN the task is NOT reset to pending (prevents duplicate claims).

**Code surface**:
- Cleanup: `apps/web/src/lib/stale-workers.ts` — `cleanupStaleWorkers()`,
  `neverStartedTeamScope()`
- Scope tests: `apps/web/src/lib/stale-workers-scope.test.ts` (renders the
  predicate builders through `PgDialect` — the behavioural test file mocks
  `drizzle-orm`, which makes WHERE-clause columns unobservable there)
- Rule: `staleWorkerScope()` in `apps/web/src/lib/stale-workers.ts` (one arm
  per rule, each carrying its own account or team scope)
- Constants: `WORKER_STALE_REAP_MS`, `WORKER_HARD_TIMEOUT_MS`,
  `WORKER_STALE_REAP_GRACE_MS` in `packages/shared/src/runner-liveness.ts`
  (their order is pinned by `packages/core/__tests__/worker-stale-thresholds.test.ts`);
  the 5-minute idle and 10-minute silent-start windows are local constants of
  `staleWorkerScope()`; `STALE_EXPIRED_ERROR`, `SILENT_START_ERROR` and
  `SILENT_START_MAX_TURNS` in `apps/web/src/lib/worker-exit-taxonomy.ts`.
  `STALE_EXPIRED_ERROR`'s text still reads "15+ minutes", a leftover from the
  old threshold; the threshold that applies is `WORKER_STALE_REAP_MS`.

---


## Claim Handoff (lost claim response)

The handoff has two boundaries. **CLAIMED** is the claim route's INSERT
(`status = 'idle'`, `startedAt IS NULL`, `runner` = the claimant's
`localUiUrl`). **SESSION_STARTED** is the runner's first `running` PATCH, which
stamps `startedAt`. Between them only the reader of the claim response knows the
worker exists. When the runner's request is aborted (client timeout,
dropped connection, process restart) after the server committed, nobody read
it. This was observed on a host runner: two claim polls timed out right after a
self-update restart, and the worker one of them minted was reaped as
`never_started` five minutes later.

**Invariants**:
- A runner that sends `claimHandoff: { pendingStartIds, claimInFlight }` on its
  heartbeat MUST list every worker it has received but not yet started.
  `activeWorkerIds` already covers started ones. The runner adds an id
  synchronously when it reads the response, before it stops counting the
  request as in flight.
- The heartbeat route MUST release (fail, `exitCause: 'never_started'`, error
  `CLAIM_RESPONSE_LOST_ERROR`) only rows of that account and that `runner`
  which are still `idle` with `startedAt IS NULL`, were minted more than
  `CLAIM_ACK_GRACE_MS` (90s, above the runner's 30s claim timeout) ago, appear
  in neither list, and only while `claimInFlight` is false.
- The release MUST be a compare-and-swap on `idle` + `startedAt IS NULL`. A
  session-start PATCH that lands first keeps its worker, so a late
  acknowledgement cannot produce two sessions.
- Released tasks MUST resolve through the reaper's rules
  (`resolveTasksOfReapedWorkers`): infra backoff, `MAX_INFRA_RETRIES`, the
  kernel hook, a wake at `startAt` from the dispatch outbox's per-minute due
  tick, and `infra_stalled` at the cap. A lost claim is never a code failure and
  never a completion.
- A runner that does not send `claimHandoff` (older build, `--once`) is never
  asked; its rows are left to the 5-minute never-started reap.

**Acceptance criteria**:
- AC-32: GIVEN an unstarted row minted 2 minutes ago for runner R, and R's
  heartbeat reports neither it nor a claim in flight, WHEN the heartbeat lands
  THEN the row is failed with `CLAIM_RESPONSE_LOST_ERROR` and its task is
  requeued.
- AC-33: GIVEN the same row and `claimInFlight: true`, or the id in
  `pendingStartIds` or `activeWorkerIds`, THEN it is untouched.
- AC-34: GIVEN the runner's `running` PATCH lands between the select and the
  release THEN the worker keeps running and the task is not requeued.

**Observability**: each release logs one
`[claim-handoff] {"event":"claim_unacknowledged_released",...}` line with
worker, task, account, runner, `mintedAt` and `ageMs`. Each lost response logs
`claim_rejected` with `status: 0` in the runner's `claims.log`. The released
row's error text is its own failure signature, so count it apart from the
generic never-started signature and add the two together when comparing totals
before and after this change.

**Code surface**:
- Server: `apps/web/src/lib/lost-claim.ts`,
  `apps/web/src/app/api/workers/heartbeat/route.ts`
- Runner: `apps/runner/src/claim-handoff.ts` (`ClaimHandoffTracker`), wired in
  `apps/runner/src/workers.ts` (`claimPendingTasks`, `claimAndStart`,
  `sendHeartbeat`)

---


## Heartbeat-driven Liveness (machine offline)

**Invariants**:
- If no `worker_heartbeats` row for the account has `lastHeartbeatAt` within the
  last **150 minutes** (`HEARTBEAT_STALE_MS`), the runner machine is considered
  offline.
- When the runner is offline, all active runner workers (`running`, `starting`,
  `idle`, `waiting_input`; never interactive `runner = 'mcp'` ones) for that
  account whose `updatedAt` is older than the cutoff are marked `failed` with
  `error: "Worker runner went offline (heartbeat expired)"`.
- **There is exactly one copy of this rule**, `failWorkersOfOfflineRunners`.
  The claim-path reaper, `POST /api/tasks/cleanup` and the per-minute
  maintenance cron all call it. A single stale heartbeat row on an account
  MUST NOT fail anything by itself while another row on the account is fresh —
  a second runner's dead row, or a restarted runner's old URL, used to fail
  every in-flight worker under the account's live runner.
- Heartbeat rows are deleted only once past the same cutoff, so "no fresh row"
  and "row deleted" mean the same thing.
- Every "is this runner up" window is a named constant derived from the
  heartbeat cadence in `packages/shared/src/runner-liveness.ts`:
  `RUNNER_LIVE_WINDOW_MS` (online now, presence UI), `RUNNER_RECENTLY_SEEN_MS`
  (demonstrably up, alarms), `RUNNER_ONLINE_THRESHOLD_MS` (online at poll
  cadence, runner lists), `RUNNER_STALE_CUTOFF_MS` (not dead). Only the last
  may gate failing workers or deleting rows.
- The 150-minute window is 2.5× the typical 60-minute poll cycle so one dropped
  heartbeat doesn't kill in-flight workers.
- **This rule MUST stay account-scoped — both halves of it.** Unlike the
  never-started arm above it carries no `startedAt IS NULL` narrowing, so it can
  kill workers mid-session. Widening only the worker query while the freshness
  lookup stays account-keyed would let one account's offline runner fail a
  sibling account's live, working workers. Widening the freshness lookup to
  match makes the gate fire only when every runner in the team is offline — a
  gate that can never fire, which is worse than no gate because it reads as
  protection.

**Acceptance criteria**:
- AC-7: GIVEN no heartbeat for an account in the last 150 minutes WHEN
  `cleanupStaleWorkers` runs THEN all active workers for that account are marked
  `failed`.
- AC-8: GIVEN at least one heartbeat for the account within 150 minutes WHEN
  `cleanupStaleWorkers` runs THEN the heartbeat-offline path is skipped (no
  workers failed by this check).
- AC-9: `heartbeatOrphanScope` and `heartbeatFreshnessScope` MUST each render a
  single-account predicate and MUST NOT reference `team_id`.
- AC-35: GIVEN an account with one stale and one fresh heartbeat row WHEN
  `POST /api/tasks/cleanup` or the maintenance cron runs THEN no worker on the
  account is failed by the offline-runner rule.

**Code surface**:
- Constant: `HEARTBEAT_STALE_MS = RUNNER_STALE_CUTOFF_MS` (150 min at the
  default cadence) in `apps/web/src/lib/stale-workers.ts`
- Rule: `failWorkersOfOfflineRunners()` in `apps/web/src/lib/stale-workers.ts`
- Scopes: `heartbeatOrphanScope()`, `heartbeatFreshnessScope()` in
  `apps/web/src/lib/stale-workers.ts`
- Query: uses `workerHeartbeats.lastHeartbeatAt` to find fresh beats

---


## Interactive (MCP-claimed) Workers

A worker minted by an MCP `claim_task` has `runner = 'mcp'`. No runner
liveness rule in this spec applies to it: the generic stale, idle,
silent-start and never-started arms of `cleanupStaleWorkers`, the
runner-heartbeat rule, and the cleanup route's 1h stalled and local-UI
heartbeat rules all exclude it (`runnerWorkerOnly()`). Its own reaper (the
2-hour idle TTL, the presence holds and the 8-hour backstop) lives in
[local-agent-presence](local-agent-presence.md), section "Interactive worker
reaper".

---


## Task Reclaim After Worker Death

**Invariants**:
- When a worker dies, `resolveStaleTask` decides the task's fate (not the caller):
  1. Worker produced deliverables (prUrl, prNumber, or artifacts) → task
     promoted to `completed`.
  2. Three or more prior `failed` workers on this task → task permanently set to
     `failed`.
  3. Otherwise → task reset to `pending` with `claimedBy = null`, preserving
     `baseBranch` and `failureContext` in `context` for the next attempt.
- `MAX_WORKER_RETRIES = 3` failed workers before permanent failure.
- `resolveCompletedTask` MUST be called after every task resolution to unblock
  downstream DAG tasks.

**Acceptance criteria**:
- AC-36: GIVEN a stale worker with a `prUrl` set WHEN `resolveStaleTask` runs
  THEN `tasks.status = 'completed'` (deliverables present).
- AC-10: GIVEN 3 prior `failed` workers on a task WHEN a 4th worker goes stale
  THEN `tasks.status = 'failed'` permanently.
- AC-11: GIVEN 1 prior `failed` worker on a task and no deliverables WHEN a
  worker goes stale THEN `tasks.status = 'pending'` with `claimedBy = null`.

**Code surface**:
- `resolveStaleTask()` in `apps/web/src/lib/stale-workers.ts`
- `MAX_WORKER_RETRIES = 3` in the same file

---


## waiting_input Timeout

**Invariants**:
- A worker stuck in `waiting_input` for **24 hours** (standalone task) or
  **4 hours** (mission task) is timed out.
- Timeout creates a retry task with the original context plus a directive not to
  ask for user input, then fails the original task and worker. A task that
  already ended (a person cancelled it) is neither failed nor retried: only the
  worker is closed.
- Before the timeout, `/api/cron/waiting-input-sweep` settles every live runner
  worker with no session (a session-ended question, a pause, a parked run)
  whose task is deleted or terminal, whatever its age
  (`settleOrphanedSessionlessWorkers`, `apps/web/src/lib/sessionless-worker-settle.ts`).
  Cancel and delete settle their own task's rows in the request; this repairs
  any left behind. See agent-question-protocol AC-53.

**Acceptance criteria**:
- AC-12: GIVEN a `waiting_input` worker on a mission task older than 4 hours
  WHEN `cleanupStuckWaitingInput` runs THEN the worker is failed and a retry task
  is created containing "Do NOT ask for user input" in the description.
- AC-13: GIVEN a standalone `waiting_input` worker older than 24 hours WHEN
  `cleanupStuckWaitingInput` runs THEN the same outcome occurs.
- AC-37: GIVEN a `waiting_input` worker past its timeout whose task is
  `cancelled` WHEN `cleanupStuckWaitingInput` runs THEN the worker is failed and
  the task keeps `cancelled`, with no retry task.
- AC-38: GIVEN a session-ended question worker whose task was deleted
  (`task_id` NULL) or is terminal WHEN the waiting-input sweep runs THEN it is
  settled first, at any age; an interactive (`mcp`) worker is left to
  interactive detach.

**Code surface**:
- `cleanupStuckWaitingInput()` in `apps/web/src/lib/stale-workers.ts`
- `settleOrphanedSessionlessWorkers()` in `apps/web/src/lib/sessionless-worker-settle.ts`
- Constants: `WAITING_INPUT_STALE_MS`, `WAITING_INPUT_MISSION_STALE_MS`

---

**Out of scope**: The sibling contracts linked in the frontmatter.

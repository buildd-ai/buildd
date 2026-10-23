---
title: Worker Reclamation
status: active
owner: max
last_verified: 2026-10-23
summary: Silent workers MUST be reclaimed with the correct timeout, exit cause and retry treatment.
domain: runners
surfaces: [apps/web/src/lib/stale-workers.ts, apps/web/src/lib/runner-offline.ts, apps/web/src/lib/lost-claim.ts, apps/web/src/lib/sessionless-worker-settle.ts]
related: [runner-heartbeat, runner-failure-alerts]
verified_by: [apps/web/src/lib/stale-workers.test.ts, apps/web/src/lib/stale-workers-dead-runner.test.ts, apps/web/src/lib/stale-workers-unvouched.test.ts, apps/runner/__tests__/unit/restart-terminal-report.test.ts, apps/web/src/lib/runner-offline.test.ts, apps/web/src/lib/sessionless-worker-settle.test.ts, apps/web/src/app/api/cron/waiting-input-sweep/route.test.ts, apps/web/src/lib/worker-exit-taxonomy.test.ts, apps/web/src/lib/lost-claim.test.ts, apps/runner/__tests__/unit/claim-handoff.test.ts]
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
- A runner whose `worker_heartbeats` row (Redis beat overlaid,
  `lib/runner-beats.ts`) has no `lastHeartbeatAt` within the last **150
  minutes** (`HEARTBEAT_STALE_MS`) is considered offline. **Each worker is
  judged by its own runner**: the row keyed on the `localUiUrl` the worker was
  claimed under (`workers.localUiUrl`, else `workers.runner`;
  `runnerLiveness` in `lib/runner-offline.ts`). Whether the account's OTHER
  runners are alive is irrelevant: keyed on the account, a dead runner's
  workers never became orphans while a sibling kept heartbeating (Oct 22: two
  workers of an offline Mac stayed `running` for hours, held their path
  leases, and tasks a person set back to pending stayed unclaimable).
- When its runner is offline, an active runner worker (`running`, `starting`,
  `idle`, `waiting_input`; never interactive `runner = 'mcp'` ones, never a
  live cloud park) is marked `failed` with `error: "Worker runner went offline
  (heartbeat expired)"`, its path claims released, and its task requeued as an
  infra failure (backoff, no retry charge) so another runner claims it.
- **Only the runner speaking counts as liveness**: its heartbeat row, the
  worker lease it renews on that beat (`workers.lease_expires_at`), and its
  worker reports (the Redis worker beat). `workers.updated_at` MUST NOT gate
  this rule: an agent message, idle probe, description-change or path-release
  notice bumps it from the server side and kept a dead runner's worker alive
  indefinitely. A candidate is a live-status worker created before the cutoff
  whose lease is null or lapsed past it.
- A worker whose runner key matches no heartbeat row is an orphan if its lease
  lapsed past the cutoff; with no lease to judge by it falls back to the old
  account-wide reading (an orphan only when no runner on the account is alive).
- **There is exactly one copy of this rule**, `failWorkersOfOfflineRunners`.
  The claim-path reaper, `POST /api/tasks/cleanup` and the per-minute
  maintenance cron all call it. A stale heartbeat row fails the workers under
  THAT runner only; it MUST NOT touch a worker under the account's other, live
  runner — a second runner's dead row, or a restarted runner's old URL, used
  to fail every in-flight worker under the account's live runner.
- Heartbeat rows are deleted only once past the same cutoff, and never while a
  live-status worker still names the runner (`heartbeatRowHasNoLiveWorkers`),
  so a runner's row outlives its workers and the rule can always judge a
  worker by its own runner.
- `explain` on a task whose live-status worker's runner has been silent past
  `RUNNER_RECENTLY_SEEN_MS` says `waiting for runner <name> (offline <n>m) to
  be confirmed dead`, not RUNNING.
- Every "is this runner up" window is a named constant derived from the
  heartbeat cadence in `packages/shared/src/runner-liveness.ts`:
  `RUNNER_LIVE_WINDOW_MS` (online now, presence UI), `RUNNER_RECENTLY_SEEN_MS`
  (demonstrably up, alarms), `RUNNER_ONLINE_THRESHOLD_MS` (online at poll
  cadence, runner lists), `RUNNER_STALE_CUTOFF_MS` (not dead). Only the last
  may gate failing workers or deleting rows.
- The 150-minute window is 2.5× the typical 60-minute poll cycle so one dropped
  heartbeat doesn't kill in-flight workers.
- **This rule MUST stay account-scoped.** Unlike the never-started arm above it
  carries no `startedAt IS NULL` narrowing, so it can kill workers mid-session.
  The candidates are judged against the account's own heartbeat rows, and a
  `localhost` URL is shared by every team's runners: widening the worker query
  to the team would let one account's offline runner fail a sibling account's
  live, working workers.

**Acceptance criteria**:
- AC-7: GIVEN no heartbeat row for an account at all WHEN `cleanupStaleWorkers`
  runs THEN all active runner workers for that account are marked `failed`.
- AC-8: GIVEN every heartbeat row on the account within 150 minutes WHEN
  `cleanupStaleWorkers` runs THEN the heartbeat-offline path is skipped (no
  workers failed by this check).
- AC-9: `heartbeatOrphanScope` MUST render a single-account predicate, MUST
  NOT reference `team_id`, and MUST NOT reference `workers.updated_at`.
- AC-35: GIVEN an account with one stale and one fresh heartbeat row WHEN
  `POST /api/tasks/cleanup` or the maintenance cron runs THEN the workers
  under the stale runner are failed and no worker under the fresh runner is.
- AC-54: GIVEN a worker under the stale runner whose `updated_at` was bumped
  a minute ago by a message WHEN the rule runs THEN it is still failed.

**Code surface**:
- Constant: `HEARTBEAT_STALE_MS = RUNNER_STALE_CUTOFF_MS` (150 min at the
  default cadence) in `apps/web/src/lib/stale-workers.ts`
- Rule: `failWorkersOfOfflineRunners()` in `apps/web/src/lib/stale-workers.ts`
- Scope: `heartbeatOrphanScope()` in `apps/web/src/lib/stale-workers.ts`;
  deletion guard `heartbeatRowHasNoLiveWorkers()`
- Judgment: `loadRunnerBeats()`, `runnerLiveness()`, `offlineRunnerWaitLine()`
  in `apps/web/src/lib/runner-offline.ts`

---


## Runner Vouching (a live runner forgot its worker)

**Invariants**:
- A runner that reports `claimHandoff` names, on every heartbeat, every worker
  it runs or holds paused (`activeWorkerIds`: working, stale, waiting) and
  every worker it received but has not started (`pendingStartIds`). The lease
  (`workers.lease_expires_at`) is renewed only by a beat that names the worker.
- A live-status worker (`running`, `starting`, `waiting_input`) of THAT runner
  that the beat does not name, and whose lease lapsed more than
  `UNVOUCHED_GRACE_MS` (10 min) ago, is one the runner forgot: its session died
  with a runner restart and the restart settled it locally without the server
  hearing. It is failed with `RUNNER_NO_LONGER_REPORTS_ERROR` (infra failure,
  or never-started for an unstarted row), seats released, and its task
  resolved by the reaper's rules (requeued with the infra backoff, completed on
  deliverables, path claims released). The write is a CAS on the same lease
  predicate, so a renewal in between wins.
- R-38 (spec c7410e76) holds: a worker the beat names, paused or running, is
  never touched, however old its lease. A NULL lease is no evidence; a runner
  that sends no handoff report is never judged by this rule.
- Checked on the heartbeat's interval write (`failWorkersUnvouchedByRunner`,
  called from `POST /api/workers/heartbeat`), not by a separate sweep.
- `explain` on such a task says `runner <name> no longer reports this worker`
  (`runnerLiveness` verdict `unvouched`), not RUNNING.
- The runner side keeps its own half: a crash-reconciled terminal report is
  stored on the worker (`terminalReport`) and retried with backoff until the
  server answers, and only the startup restore rewrites on-disk `working`
  records (`loadAllWorkers({ reconcileRestart: true })`); every other reader of
  the store leaves live records alone.

**Acceptance criteria**:
- AC-55: GIVEN a heartbeating runner whose beat omits a server-`running`
  worker of its own, with that worker's lease lapsed past `UNVOUCHED_GRACE_MS`,
  WHEN the beat's interval write runs THEN the worker is failed and its task
  resolved; a worker the beat names, including a paused one, is not touched.

**Code surface**:
- Rule: `failWorkersUnvouchedByRunner()` in `apps/web/src/lib/stale-workers.ts`
- Grace and verdict: `UNVOUCHED_GRACE_MS`, `runnerLiveness()` in
  `apps/web/src/lib/runner-offline.ts`
- Runner: `apps/runner/src/terminal-report.ts`, `loadAllWorkers()` in
  `apps/runner/src/worker-store.ts`

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

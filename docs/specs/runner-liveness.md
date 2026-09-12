---
title: Runner Liveness
status: active
owner: max
last_verified: 2026-09-11
summary: The coordination layer MUST detect a runner or worker that has gone silent, reclaim or permanently fail its task, and alert ops on systematic failure without ever blocking the claim path.
domain: runners
surfaces: [apps/web/src/lib/stale-workers.ts, apps/web/src/app/api/workers/heartbeat/route.ts, packages/shared/src/runner-liveness.ts, packages/core/runner-health.ts]
related: [provider-failover, mission-task-lifecycle]
keywords: [worker_heartbeats, heartbeat_stale_ms, cleanupstaleworkers, waiting_input timeout, buildd_runner_poll_min, viewertoken, runner_commit, runner_version, deployed build sha]
assertions:
  - id: heartbeat-route
    type: route
    method: POST
    path: /api/workers/heartbeat
    file: apps/web/src/app/api/workers/heartbeat/route.ts
  - id: cleanup-stale-workers
    type: symbol
    name: cleanupStaleWorkers
    path: apps/web/src/lib/stale-workers.ts
  - id: cleanup-stuck-waiting-input
    type: symbol
    name: cleanupStuckWaitingInput
    path: apps/web/src/lib/stale-workers.ts
  - id: record-runner-outcome
    type: symbol
    name: recordRunnerOutcome
    path: packages/core/runner-health.ts
supersedes: []
---
# Runner Liveness

**Capability statement**: The buildd coordination layer MUST detect when a
runner instance or individual worker has gone silent, reclaim the affected task
(reset to pending or permanently fail it), and alert ops when failures become
systematic — without ever blocking the normal claim path.

---

## Runner Heartbeat Protocol

**Invariants**:
- Runners MUST call `POST /api/workers/heartbeat` with `localUiUrl` on each
  `BUILDD_RUNNER_POLL_MIN`-minute cycle (default **60 minutes**; configured via
  the same env var on both the runner host and server). The exported constant is
  `RUNNER_HEARTBEAT_INTERVAL_MS` from `packages/shared/src/runner-liveness.ts`.
  To change the interval, update `BUILDD_RUNNER_POLL_MIN` on both runner and
  server so liveness thresholds scale together.
- **Note:** Pusher delivers realtime task notifications to runners. The heartbeat
  interval is NOT a polling frequency for new tasks — Pusher handles task
  delivery. The heartbeat exists solely to register the runner as alive and to
  maintain the liveness window used by stale-detection.
- Each `(accountId, localUiUrl)` pair has at most one `worker_heartbeats` row;
  the upsert on conflict refreshes `lastHeartbeatAt`.
- The server issues a `viewerToken` on the first registration for that
  `(accountId, localUiUrl)` pair; subsequent heartbeats reuse it (token is
  stable for the runner instance's lifetime).
- `workspaceIds` on `worker_heartbeats` is deprecated and always written as `[]`;
  workspace association is resolved on demand by `GET /api/workers/active`.
- Each heartbeat MAY carry `runnerCommit` (the runner codebase's own `git
  rev-parse HEAD`, read fresh from disk each beat) and `runnerVersion`
  (`package.json` version, read once at process start) — the runner's own
  build identity, not a task's commit. Persisted verbatim to
  `worker_heartbeats.runner_commit` / `.runner_version` and surfaced on
  `GET /api/workers/active`. This is how a runner instance still serving
  pre-fix code becomes distinguishable from one running a merged fix, without
  SSH access to the host: before this field existed, a runner's actual
  deployed commit was observable only via its own local, unauthenticated-off-box
  `/api/version` endpoint (`apps/runner/src/index.ts`), which nothing on the
  platform side ever polled. Both fields are `null` for a runner older than
  this change (it simply omits them from the POST body) — treat `null` as
  "unknown", not "on an old commit".

**Acceptance criteria**:
- AC-1: WHEN `POST /api/workers/heartbeat` is called without `localUiUrl` THEN
  the server returns HTTP 400.
- AC-2: WHEN a runner sends its first heartbeat THEN the response contains a
  `viewerToken` that remains unchanged on all subsequent heartbeats for the same
  `localUiUrl`.
- AC-3: WHEN a valid heartbeat is received THEN `lastHeartbeatAt` is updated to
  `NOW()` in `worker_heartbeats`.
- AC-17: WHEN a heartbeat carries `runnerCommit`/`runnerVersion` THEN both are
  persisted verbatim to `worker_heartbeats` and returned by
  `GET /api/workers/active`.
- AC-18: WHEN a heartbeat omits `runnerCommit`/`runnerVersion` (legacy runner)
  THEN both are stored as `null`, not overwritten with a stale prior value from
  a different field.

**Code surface**:
- Route: `apps/web/src/app/api/workers/heartbeat/route.ts`
- Schema: `packages/core/db/schema.ts` — `workerHeartbeats` table
- Runner send site: `apps/runner/src/workers.ts` (`sendHeartbeat`),
  `apps/runner/src/buildd.ts` (`BuilddClient.sendHeartbeat`)
- Runner commit/version source: `apps/runner/src/updater.ts` (`getCurrentCommit`,
  `PKG_VERSION`)
- Dashboard surface: `apps/web/src/app/api/workers/active/route.ts`

---

## Stale Worker Detection (per-worker timeout)

**Invariants**:
- A worker in `running` or `starting` status with no `updatedAt` change for
  **15 minutes** is stale.
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
- AC-4: GIVEN a worker in `running` status with `updatedAt` > 15 minutes ago
  WHEN `cleanupStaleWorkers` runs THEN the worker status transitions to `failed`
  with `error: "Stale worker expired (no update for 15+ minutes)"`.
- AC-5: GIVEN an `idle` worker with `updatedAt` > 5 minutes ago WHEN
  `cleanupStaleWorkers` runs THEN the worker is marked `failed`.
- AC-5a: GIVEN an `idle` worker with `startedAt IS NULL` past the idle threshold
  belonging to account A WHEN `cleanupStaleWorkers(B)` runs for a different
  account B in the SAME team THEN the worker is marked `failed` with
  `exitCause: 'never_started'`, and `activeSessions` is decremented on account
  A, not on account B.
- AC-5b: GIVEN the same row WHEN `cleanupStaleWorkers` runs for an account in a
  DIFFERENT team THEN the worker is left untouched.
- AC-6: GIVEN a stale worker whose task has another active worker WHEN cleanup
  runs THEN the task is NOT reset to pending (prevents duplicate claims).

**Code surface**:
- Cleanup: `apps/web/src/lib/stale-workers.ts` — `cleanupStaleWorkers()`,
  `neverStartedTeamScope()`
- Scope tests: `apps/web/src/lib/stale-workers-scope.test.ts` (renders the
  predicate builders through `PgDialect` — the behavioural test file mocks
  `drizzle-orm`, which makes WHERE-clause columns unobservable there)
- Constants: `STALE_THRESHOLD_MS = 15 * 60 * 1000`,
  `IDLE_STALE_THRESHOLD_MS = 5 * 60 * 1000`

---

## Heartbeat-driven Liveness (machine offline)

**Invariants**:
- If no `worker_heartbeats` row for the account has `lastHeartbeatAt` within the
  last **150 minutes** (`HEARTBEAT_STALE_MS`), the runner machine is considered
  offline.
- When the runner is offline, all active workers (`running`, `starting`, `idle`,
  `waiting_input`) for that account whose `updatedAt` is older than the cutoff
  are marked `failed` with `error: "Worker runner went offline (heartbeat expired)"`.
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

**Code surface**:
- Constant: `HEARTBEAT_STALE_MS = 150 * 60 * 1000` in
  `apps/web/src/lib/stale-workers.ts`
- Scopes: `heartbeatOrphanScope()`, `heartbeatFreshnessScope()` in
  `apps/web/src/lib/stale-workers.ts`
- Query: uses `workerHeartbeats.lastHeartbeatAt` to find fresh beats

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
- AC-9: GIVEN a stale worker with a `prUrl` set WHEN `resolveStaleTask` runs
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
  ask for user input, then fails the original task and worker.

**Acceptance criteria**:
- AC-12: GIVEN a `waiting_input` worker on a mission task older than 4 hours
  WHEN `cleanupStuckWaitingInput` runs THEN the worker is failed and a retry task
  is created containing "Do NOT ask for user input" in the description.
- AC-13: GIVEN a standalone `waiting_input` worker older than 24 hours WHEN
  `cleanupStuckWaitingInput` runs THEN the same outcome occurs.

**Code surface**:
- `cleanupStuckWaitingInput()` in `apps/web/src/lib/stale-workers.ts`
- Constants: `WAITING_INPUT_STALE_MS`, `WAITING_INPUT_MISSION_STALE_MS`

---

## Systemic Failure Detection

**Invariants**:
- `recordRunnerOutcome` tracks a consecutive-failure streak in `system_cache`
  key `runner-health:consecutive-failures` (atomic jsonb counter).
- A completed task resets the streak to 0.
- When the streak reaches `RUNNER_HEALTH_FAILURE_THRESHOLD` (default 3), a
  single critical ops alert is fired via `reportOps` with `dedupeKey:
  'runner-health'` — subsequent failures within the dedup window do NOT repeat
  the page.
- The entire subsystem is a no-op when `OPS_ALERTS_ENABLED` is falsy.

**Acceptance criteria**:
- AC-14: GIVEN `OPS_ALERTS_ENABLED = 'true'` WHEN 3 consecutive tasks fail
  THEN `reportOps` is called with `severity: 'critical'` and `source:
  'runner-health'`.
- AC-15: GIVEN a completed task WHEN `recordRunnerOutcome('completed')` runs
  THEN `system_cache` streak resets to 0.
- AC-16: GIVEN `OPS_ALERTS_ENABLED` unset WHEN `recordRunnerOutcome('failed')`
  is called THEN it returns immediately without any DB write.

**Code surface**:
- `packages/core/runner-health.ts` — `recordRunnerOutcome()`
- `STREAK_KEY = 'runner-health:consecutive-failures'`
- `packages/core/report-ops.ts` — `reportOps()`

**Out of scope**: The Pusher-based `WORKER_COMMAND: 'recover'` recovery path
(`attemptStaleRecovery`), which is best-effort and not yet called from a
reliable cron. The runner's own internal health checks (out of process).

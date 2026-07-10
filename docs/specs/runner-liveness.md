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

**Acceptance criteria**:
- AC-1: WHEN `POST /api/workers/heartbeat` is called without `localUiUrl` THEN
  the server returns HTTP 400.
- AC-2: WHEN a runner sends its first heartbeat THEN the response contains a
  `viewerToken` that remains unchanged on all subsequent heartbeats for the same
  `localUiUrl`.
- AC-3: WHEN a valid heartbeat is received THEN `lastHeartbeatAt` is updated to
  `NOW()` in `worker_heartbeats`.

**Code surface**:
- Route: `apps/web/src/app/api/workers/heartbeat/route.ts`
- Schema: `packages/core/db/schema.ts` — `workerHeartbeats` table

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
  are cleaned up.

**Acceptance criteria**:
- AC-4: GIVEN a worker in `running` status with `updatedAt` > 15 minutes ago
  WHEN `cleanupStaleWorkers` runs THEN the worker status transitions to `failed`
  with `error: "Stale worker expired (no update for 15+ minutes)"`.
- AC-5: GIVEN an `idle` worker with `updatedAt` > 5 minutes ago WHEN
  `cleanupStaleWorkers` runs THEN the worker is marked `failed`.
- AC-6: GIVEN a stale worker whose task has another active worker WHEN cleanup
  runs THEN the task is NOT reset to pending (prevents duplicate claims).

**Code surface**:
- Cleanup: `apps/web/src/lib/stale-workers.ts` — `cleanupStaleWorkers()`
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

**Acceptance criteria**:
- AC-7: GIVEN no heartbeat for an account in the last 150 minutes WHEN
  `cleanupStaleWorkers` runs THEN all active workers for that account are marked
  `failed`.
- AC-8: GIVEN at least one heartbeat for the account within 150 minutes WHEN
  `cleanupStaleWorkers` runs THEN the heartbeat-offline path is skipped (no
  workers failed by this check).

**Code surface**:
- Constant: `HEARTBEAT_STALE_MS = 150 * 60 * 1000` in
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

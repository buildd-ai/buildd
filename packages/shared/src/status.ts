/**
 * Canonical status vocabularies for tasks, workers and missions.
 *
 * Every "is this task open?", "has this worker ended?", "is an agent live?"
 * check reads these lists. Inline copies drifted (one counted `review`, one
 * forgot `cancelled`, one forgot `superseded`, one dropped `idle`) — so a new
 * copy is caught by `scripts/status-literal-ratchet.test.ts` (vocabulary tests:
 * `packages/core/__tests__/status-vocabulary.test.ts`).
 *
 * The unions below are the values the `status` columns actually hold, and are
 * applied to those columns with `$type<>` in packages/core/db/schema.ts.
 */

// ─── Tasks ────────────────────────────────────────────────────────────────────

/**
 * Every value `tasks.status` can hold. `in_progress` and `review` are legacy:
 * nothing writes them today, but readers still tolerate them on old rows.
 */
export const TASK_STATUSES = ['pending', 'assigned', 'in_progress', 'review', 'completed', 'failed', 'cancelled'] as const;
export type TaskStatusValue = (typeof TASK_STATUSES)[number];

/**
 * Task statuses that mean "not finished yet" — queued, dispatched or running.
 * `review` is deliberately absent: it is never written, and counting it open
 * made one copy (health watcher) disagree with every other.
 */
export const OPEN_TASK_STATUSES = ['pending', 'assigned', 'in_progress'] as const;
export type OpenTaskStatus = (typeof OPEN_TASK_STATUSES)[number];

/** Task statuses that end the task. A cancel counts. */
export const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

/**
 * Task statuses where no agent has started running the task yet: queued or
 * dispatched but not in progress. Safe to re-dispatch.
 */
export const UNCLAIMED_TASK_STATUSES = ['pending', 'assigned'] as const;

/**
 * Task statuses a task may be deleted from (DELETE /api/tasks/[id] without
 * `force`, and the dashboard's delete button). Everything except one an agent
 * is actively running.
 */
export const DELETABLE_TASK_STATUSES = [...UNCLAIMED_TASK_STATUSES, ...TERMINAL_TASK_STATUSES] as const;

// ─── Workers ──────────────────────────────────────────────────────────────────

/**
 * Every value `workers.status` can hold. `done` is legacy (old rows only; the
 * runner's local `done` is reported to the server as `completed`).
 */
export const WORKER_STATUSES = [
  'idle', 'starting', 'running', 'waiting_input', 'paused',
  'completed', 'failed', 'error', 'superseded', 'done',
] as const;
export type WorkerStatusValue = (typeof WORKER_STATUSES)[number];

/**
 * Worker statuses that indicate an active (live) worker. Use this in every DB
 * query that joins workers to filter for active ones. `paused` is not live.
 * task.status NEVER becomes 'running'; liveness is worker-derived only.
 */
export const LIVE_WORKER_STATUSES = ['idle', 'running', 'starting', 'waiting_input'] as const;
export type LiveWorkerStatus = (typeof LIVE_WORKER_STATUSES)[number];

/**
 * Worker statuses from which no further live update is legal. `superseded`
 * (an answered question whose work moved to a continuation task) is as final
 * as `completed`: the check-in route 409s it like the others.
 */
export const TERMINAL_WORKER_STATUSES = ['completed', 'failed', 'error', 'superseded', 'done'] as const;
export type TerminalWorkerStatus = (typeof TERMINAL_WORKER_STATUSES)[number];

/** Worker statuses that count as a failure. `error` is the legacy spelling. */
export const FAILED_WORKER_STATUSES = ['failed', 'error'] as const;

// ─── Missions ─────────────────────────────────────────────────────────────────

/** Every value `missions.status` can hold. */
export const MISSION_STATUSES = ['active', 'paused', 'completed', 'archived', 'budget_exhausted'] as const;
export type MissionStatusValue = (typeof MISSION_STATUSES)[number];

// ─── Predicates ───────────────────────────────────────────────────────────────

function member(list: readonly string[]) {
  return (status: string | null | undefined): boolean => typeof status === 'string' && list.includes(status);
}

export const isOpenTaskStatus = member(OPEN_TASK_STATUSES) as (s: string | null | undefined) => s is OpenTaskStatus;
export const isTerminalTaskStatus = member(TERMINAL_TASK_STATUSES) as (s: string | null | undefined) => s is TerminalTaskStatus;
export const isLiveWorkerStatus = member(LIVE_WORKER_STATUSES) as (s: string | null | undefined) => s is LiveWorkerStatus;
export const isTerminalWorkerStatus = member(TERMINAL_WORKER_STATUSES) as (s: string | null | undefined) => s is TerminalWorkerStatus;

/** Whether a task in this status may be deleted without `force`. */
export const canDeleteTask = member(DELETABLE_TASK_STATUSES);

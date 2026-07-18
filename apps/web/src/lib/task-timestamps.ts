/** Staleness: running worker with no updatedAt activity beyond this threshold. */
export const STALENESS_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * The canonical set of worker statuses that indicate an active (live) worker.
 * A worker is "live" when it is between turns (idle), starting up, actively
 * executing (running), or blocked waiting for user input. Use this single
 * source of truth in every DB query that joins workers to filter for active ones.
 */
export const LIVE_WORKER_STATUSES = ['idle', 'running', 'starting', 'waiting_input'] as const;

/**
 * Derives the canonical display status for a task from its DB status and the
 * latest active worker's status. This is the single authoritative source for
 * what label/chip to show — callers must not fork their own logic.
 *
 * Rule: if there is an active running worker, the task always displays as
 * "running" regardless of the task.status column value (which may still be
 * "assigned" while the runner transitions). An idle worker (between turns)
 * is treated the same as running — the agent is still active.
 */
export function deriveDisplayStatus(
  taskStatus: string,
  workerStatus?: string | null,
): string {
  if (workerStatus === 'running' || workerStatus === 'starting' || workerStatus === 'idle') return 'running';
  if (workerStatus === 'waiting_input') return 'waiting_input';
  return taskStatus;
}

/**
 * Returns true when a running worker has not emitted any update past the
 * staleness threshold — the hung-worker signal.
 */
export function isStaleWorker(
  workerStatus: string | null | undefined,
  workerUpdatedAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (workerStatus !== 'running') return false;
  if (!workerUpdatedAt) return false;
  return now - new Date(workerUpdatedAt).getTime() > STALENESS_THRESHOLD_MS;
}

function durToStr(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function agoStr(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export interface TimestampLabelParams {
  taskStatus: string;
  workerStatus?: string | null;
  taskCreatedAt: string;
  taskUpdatedAt: string;
  workerStartedAt?: string | null;
  workerUpdatedAt?: string | null;
  now?: number;
}

/**
 * Returns a human-readable timestamp label keyed by the task's canonical
 * display status. Examples:
 *   running   → "running 58m · active 1m ago"
 *   running (stale) → shown as above; callers use isStaleWorker for styling
 *   waiting   → "needs input · 45m"
 *   queued    → "queued 3h"
 *   completed → "2h ago"
 */
export function deriveTimestampLabel(params: TimestampLabelParams): string {
  const {
    taskStatus,
    workerStatus,
    taskCreatedAt,
    taskUpdatedAt,
    workerStartedAt,
    workerUpdatedAt,
    now = Date.now(),
  } = params;

  const displayStatus = deriveDisplayStatus(taskStatus, workerStatus);

  if (displayStatus === 'running') {
    const startMs = workerStartedAt
      ? new Date(workerStartedAt).getTime()
      : new Date(taskCreatedAt).getTime();
    const runMs = now - startMs;
    const lastActivityMs = workerUpdatedAt ? now - new Date(workerUpdatedAt).getTime() : 0;
    return `running ${durToStr(runMs)} · active ${agoStr(lastActivityMs)}`;
  }

  if (displayStatus === 'waiting_input') {
    const startMs = workerStartedAt
      ? new Date(workerStartedAt).getTime()
      : new Date(taskCreatedAt).getTime();
    return `needs input · ${durToStr(now - startMs)}`;
  }

  if (taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'cancelled') {
    return agoStr(now - new Date(taskUpdatedAt).getTime());
  }

  // pending / assigned / in_progress without active worker
  return `queued ${durToStr(now - new Date(taskCreatedAt).getTime())}`;
}

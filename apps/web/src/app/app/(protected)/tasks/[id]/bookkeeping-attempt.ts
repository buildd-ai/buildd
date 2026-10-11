/**
 * A worker row booked `never_started` is a bookkeeping record: the runner
 * claimed the task and no session ever began (`classifyStaleExit`). Its
 * `status` is `failed` because the row is terminal, not because the task
 * failed, so while the task is still going to be attempted again the history
 * says so plainly instead of drawing a failure.
 *
 * Pure. It reads only the worker's own `exitCause` and the task's status and
 * `startAt`; it derives no mission or workflow state.
 */
export type BookkeepingRetry =
  /** The task is pending with a future `startAt`: the retry time is known. */
  | { kind: 'scheduled'; atIso: string }
  /** The task is queued with no wait-until: it is next in line. */
  | { kind: 'queued' };

const RETRYABLE_TASK_STATUSES = new Set(['pending', 'assigned']);

export function bookkeepingAttemptRetry(
  worker: { status: string; exitCause?: string | null },
  task: { status: string; startAt?: Date | string | null },
  now: Date = new Date(),
): BookkeepingRetry | null {
  if (worker.status !== 'failed' || worker.exitCause !== 'never_started') return null;
  // Terminal task (retries exhausted, cancelled, ...): no retry is promised, so
  // the row keeps its ordinary failure presentation.
  if (!RETRYABLE_TASK_STATUSES.has(task.status)) return null;
  const startAt = task.startAt ? new Date(task.startAt) : null;
  if (startAt && !Number.isNaN(startAt.getTime()) && startAt > now) {
    return { kind: 'scheduled', atIso: startAt.toISOString() };
  }
  return { kind: 'queued' };
}

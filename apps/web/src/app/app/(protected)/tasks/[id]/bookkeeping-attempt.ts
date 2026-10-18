/**
 * A worker row booked `never_started` is a bookkeeping record: the runner
 * claimed the task and no session ever began (`classifyStaleExit`), or the
 * claim never reached the runner at all (lib/lost-claim.ts). Its `status` is
 * `failed` because the row is terminal, not because anything ran and failed,
 * so the history never draws it as a failure: while the task will be tried
 * again it says when, and once the task is settled it just says nothing ran.
 *
 * Pure. It reads only the worker's own `exitCause` and `error` and the task's
 * status and `startAt`; it derives no mission or workflow state.
 */
import { CLAIM_RESPONSE_LOST_ERROR } from '@/lib/worker-exit-taxonomy';

export type BookkeepingRetry =
  /** The task is pending with a future `startAt`: the retry time is known. */
  | { kind: 'scheduled'; atIso: string }
  /** The task is queued with no wait-until: it is next in line. */
  | { kind: 'queued' }
  /** The task is no longer waiting for a retry (it ran, finished or was cancelled). */
  | { kind: 'settled' };

const RETRYABLE_TASK_STATUSES = new Set(['pending', 'assigned']);

export function isBookkeepingAttempt(worker: { status: string; exitCause?: string | null }): boolean {
  return worker.status === 'failed' && worker.exitCause === 'never_started';
}

/** The runner reported it never received this claim, as opposed to receiving it and not starting it. */
export function isUndeliveredClaim(worker: { error?: string | null }): boolean {
  return worker.error === CLAIM_RESPONSE_LOST_ERROR;
}

export function bookkeepingAttemptRetry(
  worker: { status: string; exitCause?: string | null },
  task: { status: string; startAt?: Date | string | null },
  now: Date = new Date(),
): BookkeepingRetry | null {
  if (!isBookkeepingAttempt(worker)) return null;
  if (!RETRYABLE_TASK_STATUSES.has(task.status)) return { kind: 'settled' };
  const startAt = task.startAt ? new Date(task.startAt) : null;
  if (startAt && !Number.isNaN(startAt.getTime()) && startAt > now) {
    return { kind: 'scheduled', atIso: startAt.toISOString() };
  }
  return { kind: 'queued' };
}

export type AttemptHistoryItem<E> =
  | { kind: 'attempt'; entry: E }
  /**
   * One or more bookkeeping rows in a row, shown as one line. `retry` is only
   * promised by the newest group (the head of the history); an older run of
   * them was followed by a real attempt, so it is settled.
   */
  | { kind: 'bookkeeping'; entries: E[]; retry: BookkeepingRetry; undelivered: boolean };

/**
 * Collapse consecutive bookkeeping rows of a newest-first history into one
 * item each, so four lost claims read as one line, not four failures.
 */
export function groupAttemptHistory<E extends { worker: { status: string; exitCause?: string | null; error?: string | null } }>(
  history: readonly E[],
  task: { status: string; startAt?: Date | string | null },
  now: Date = new Date(),
): AttemptHistoryItem<E>[] {
  const out: AttemptHistoryItem<E>[] = [];
  for (const entry of history) {
    const retry = bookkeepingAttemptRetry(entry.worker, task, now);
    if (!retry) {
      out.push({ kind: 'attempt', entry });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === 'bookkeeping') {
      last.entries.push(entry);
      last.undelivered = last.undelivered && isUndeliveredClaim(entry.worker);
      continue;
    }
    // A run below a real attempt promises no retry: that attempt was the retry.
    const settled = out.some(i => i.kind === 'attempt');
    out.push({ kind: 'bookkeeping', entries: [entry], retry: settled ? { kind: 'settled' } : retry, undelivered: isUndeliveredClaim(entry.worker) });
  }
  return out;
}

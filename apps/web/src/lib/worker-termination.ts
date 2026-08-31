/**
 * Worker termination vocabulary.
 *
 * `workers.error` doubles as a control signal: the PATCH handler refuses to
 * reactivate a terminal worker whose error says the SERVER killed it (the
 * runner is gone, so there is nothing to resume). That check used to be an
 * inline list of prose fragments, which meant every new terminator had to
 * guess the magic wording — `/api/tasks/[id]/reassign` wrote
 * 'Task was reassigned' and matched none of them, so a reassigned worker stayed
 * reactivatable (and answerable) after its task had moved to another worker.
 *
 * Terminators MUST write their error via the constants below, and readers MUST
 * use `isNonReactivatableError` rather than re-deriving the phrase list.
 */

/** Set by POST /api/tasks/[id]/reassign when it fails the task's live workers. */
export const REASSIGNED_WORKER_ERROR = 'Task was reassigned';

/** Set by POST /api/workers/[id]/interrupt on human takeover. */
export const INTERRUPTED_WORKER_ERROR = 'Interrupted — human takeover';

/**
 * Substrings that mark a termination the server owns. A worker terminated for
 * one of these reasons MUST NOT be reactivated or recovered: either the runner
 * is gone (expiry/heartbeat/restart) or the work has been handed elsewhere
 * (reassign/takeover).
 */
export const NON_REACTIVATABLE_ERROR_PHRASES = [
  INTERRUPTED_WORKER_ERROR,
  REASSIGNED_WORKER_ERROR,
  'expired',
  'timed out',
  'went offline',
  'runner restarted',
] as const;

export function isNonReactivatableError(error?: string | null): boolean {
  if (!error) return false;
  return NON_REACTIVATABLE_ERROR_PHRASES.some((phrase) => error.includes(phrase));
}

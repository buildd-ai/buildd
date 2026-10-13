/**
 * How a worker's terminal PATCH reads as the end of a kernel attempt
 * (docs/specs/workflow-state-kernel.md §6.6, S30).
 *
 * A runner whose hand-off failed after the session did work ("no confirmed
 * outcome", "commits but no PR", "uncommitted changes", an unmet output
 * requirement, a fix whose head never reached GitHub) reports `failed` with
 * `outcome: 'unproven'` plus the local head and commit count it saw. That is
 * not a failure of the work: the work exists, it is just not on GitHub, so it
 * ends the attempt as `AttemptEnded(unproven)` — `AWAITING_PUSH` when commits
 * exist, a `WORKING` requeue when nothing exists.
 *
 * Runners deploy only through releases to main, so an old runner omits these
 * fields. Absent means exactly today's mapping: `completed` or `failed`.
 */

export type AttemptEndStatus = 'completed' | 'failed' | 'unproven';

export interface AttemptEnd {
  status: AttemptEndStatus;
  localHeadSha: string | null;
  commitCount: number;
}

export function attemptEndFromPatch(p: {
  /** The status the route settled on (a contract violation or slot failure already folded to `failed`). */
  status: 'completed' | 'failed';
  /** The raw PATCH body fields the runner sends; anything else is ignored. */
  outcome?: unknown;
  localHeadSha?: unknown;
  commitCount?: unknown;
  /** What the route already knows when the runner did not say. */
  fallbackLocalHeadSha: string | null;
  fallbackCommitCount: number;
}): AttemptEnd {
  const unproven = p.status === 'failed' && p.outcome === 'unproven';
  const sha = typeof p.localHeadSha === 'string' && p.localHeadSha.trim() ? p.localHeadSha.trim() : null;
  const count = typeof p.commitCount === 'number' && Number.isFinite(p.commitCount) && p.commitCount >= 0
    ? Math.floor(p.commitCount)
    : null;
  return {
    status: unproven ? 'unproven' : p.status,
    localHeadSha: sha ?? p.fallbackLocalHeadSha,
    commitCount: count ?? p.fallbackCommitCount,
  };
}

/**
 * Whether the task's own auto-retry stands in for the attempt end. A plain
 * failure that the task retries is not an attempt end (§5.7 rule 2): the
 * delivery stays where it is and the retry is the requeue. An unproven end is
 * reported anyway when the kernel has something to record:
 *   - local commits exist: the work is there and only a push is missing, so
 *     the delivery goes to `AWAITING_PUSH` even while the task retries (the
 *     retry's push is what ends recovery, through T3);
 *   - an owner attempt with nothing local: the kernel records the `WORKING`
 *     requeue itself (`taskRetryBudgetLeft`), instead of a silent no-op.
 * A repair attempt with nothing local stays covered by the retry: reporting it
 * would re-dispatch a fix beside the task's own retry.
 */
export function taskRetryCoversAttemptEnd(end: AttemptEnd, shouldAutoRetry: boolean, deliveryRole: string | null): boolean {
  if (!shouldAutoRetry) return false;
  if (end.status !== 'unproven') return true;
  return end.commitCount === 0 && deliveryRole !== 'owner';
}

/**
 * Merge-card outcome mapping and refresh pacing.
 *
 * Home is a `force-dynamic` server component with no realtime subscription, so
 * an open tab holds an action queue frozen at page-load time. A "Merge" card
 * can therefore outlive the merge it is asking for — PR #1886 was merged on
 * GitHub at 14:03 (webhook stamped `mergedAt` one second later) while the card
 * still offered a Merge button. Acting on that card must read as "this card was
 * out of date", never as a failure.
 */

export type MergeOutcome =
  | { kind: 'merged' }
  /** The PR was already merged/closed upstream — the card, not the merge, failed. */
  | { kind: 'stale' }
  | { kind: 'conflict_dispatched'; taskId: string | null }
  | { kind: 'conflict_exhausted' }
  /**
   * GitHub refused the merge for conflicts and no automatic fix was filed
   * (automatic resolution is off, or the dispatch was refused). The same merge
   * cannot succeed until the branch changes, so this is never a Retry: the
   * card points at the conflict instead.
   */
  | { kind: 'conflict_blocked'; message: string }
  /**
   * The merge request itself got no usable answer from GitHub (empty/unparseable
   * body, timeout, network failure) — NOT a rejection. The server already
   * re-read the PR's live state before returning this: `open` means the merge
   * definitely didn't land and retrying is safe; `unknown` means even that
   * re-check failed, so retrying could double-attempt an already-landed merge.
   */
  | { kind: 'indeterminate'; liveState: 'open' | 'unknown'; message: string }
  /**
   * A reviewer finding is outstanding on the commit being merged, or a review
   * round is still in flight. Not a failure and not a stale card — the merge
   * was refused on purpose. A human can still merge by re-posting with
   * `override: true`, which is recorded as a bypass server-side.
   */
  | { kind: 'review_blocked'; message: string; clearedBy: string | null }
  /**
   * The landing function answered `waiting_ci`: checks or a review round are
   * still running on the PR head. A machine-owned wait, not a failure — there
   * is nothing to retry and nothing to dismiss; the card re-derives on refresh
   * and moves out of "Needs you" (resolveMergeChip).
   */
  | { kind: 'pending'; message: string }
  | { kind: 'error'; message: string };

/** `/api/prs/[prNumber]/merge` returns this 404 when no unmerged worker matches. */
const ALREADY_MERGED_RE = /already merged/i;

export function resolveMergeOutcome(
  ok: boolean,
  status: number,
  body: Record<string, unknown> | null | undefined,
): MergeOutcome {
  if (ok) return { kind: 'merged' };

  if (body?.conflictRetryDispatched) {
    const taskId = body.conflictRetryTaskId;
    return { kind: 'conflict_dispatched', taskId: typeof taskId === 'string' ? taskId : null };
  }
  if (body?.conflictExhausted) return { kind: 'conflict_exhausted' };

  const message = typeof body?.error === 'string' ? body.error : '';
  if (body?.mergeConflict) return { kind: 'conflict_blocked', message: message || 'The PR has merge conflicts' };
  if (status === 404 && ALREADY_MERGED_RE.test(message)) return { kind: 'stale' };

  const landing = body?.landing;
  if (landing && typeof landing === 'object' && (landing as { kind?: unknown }).kind === 'waiting_ci') {
    return { kind: 'pending', message: message || 'Checks or the review are still running on the PR head.' };
  }

  if (body?.reviewGateBlocked) {
    return {
      kind: 'review_blocked',
      message: message || 'A reviewer finding is outstanding on this PR',
      clearedBy: typeof body.clearedBy === 'string' ? body.clearedBy : null,
    };
  }

  if (body?.indeterminate) {
    const liveState = body.liveState === 'open' ? 'open' : 'unknown';
    return { kind: 'indeterminate', liveState, message: message || "Could not confirm the merge's result" };
  }

  return { kind: 'error', message: message || 'Merge failed' };
}

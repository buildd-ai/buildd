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
   * The merge request itself got no usable answer from GitHub (empty/unparseable
   * body, timeout, network failure) — NOT a rejection. The server already
   * re-read the PR's live state before returning this: `open` means the merge
   * definitely didn't land and retrying is safe; `unknown` means even that
   * re-check failed, so retrying could double-attempt an already-landed merge.
   */
  | { kind: 'indeterminate'; liveState: 'open' | 'unknown'; message: string }
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
  if (status === 404 && ALREADY_MERGED_RE.test(message)) return { kind: 'stale' };

  if (body?.indeterminate) {
    const liveState = body.liveState === 'open' ? 'open' : 'unknown';
    return { kind: 'indeterminate', liveState, message: message || "Could not confirm the merge's result" };
  }

  return { kind: 'error', message: message || 'Merge failed' };
}

/**
 * Minimum quiet period before a tab regaining visibility re-renders Home.
 * Long enough that flicking between tabs doesn't hammer the server component,
 * short enough that a tab left open overnight is never acted on stale.
 */
export const MIN_VISIBILITY_REFRESH_MS = 30_000;

export function shouldRefreshOnVisible(
  lastRefreshAt: number,
  now: number,
  minIntervalMs: number = MIN_VISIBILITY_REFRESH_MS,
): boolean {
  return now - lastRefreshAt >= minIntervalMs;
}

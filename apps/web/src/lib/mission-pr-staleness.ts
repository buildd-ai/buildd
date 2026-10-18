/**
 * Which of a mission's PRs a page should ask GitHub about (spec 3ef37387
 * R-12): only a PR whose recorded state could still be wrong. A PR recorded
 * merged or closed is settled, and one whose row moved in the last few
 * minutes was just written by a webhook or the sweep. Pure: the page passes
 * the rows it already loaded.
 */

/** A PR row younger than this was just written; asking GitHub again tells nothing new. */
export const PR_STATE_FRESH_MS = 5 * 60_000;

export interface PrStateRow {
  status: string;
  workers?: ReadonlyArray<{
    id: string;
    prUrl?: string | null;
    prNumber?: number | null;
    mergedAt?: Date | string | null;
    prLifecycleStatus?: string | null;
    updatedAt?: Date | string | null;
    workspaceId?: string | null;
  }> | null;
}

const settled = (w: NonNullable<PrStateRow['workers']>[number]) =>
  w.mergedAt != null || w.prLifecycleStatus === 'merged' || w.prLifecycleStatus === 'closed';

const fresh = (w: NonNullable<PrStateRow['workers']>[number], now: number) => {
  const at = w.updatedAt ? new Date(w.updatedAt).getTime() : NaN;
  return Number.isFinite(at) && now - at < PR_STATE_FRESH_MS;
};

/**
 * Completed tasks whose newest worker's PR is open on record and not just
 * written: the merge webhook may have been missed. In the rows' order.
 */
export function unseenMergeCandidates<T extends PrStateRow>(tasks: readonly T[], now: number, fallbackWorkspaceId: string | null) {
  return tasks.flatMap(t => {
    if (t.status !== 'completed') return [];
    const w = t.workers?.[0];
    if (!w?.prNumber || !w.prUrl || settled(w) || fresh(w, now)) return [];
    const workspaceId = w.workspaceId ?? fallbackWorkspaceId;
    return workspaceId ? [{ id: w.id, prNumber: w.prNumber, prUrl: w.prUrl, workspaceId }] : [];
  });
}

/** Whether opening the page should reconcile the mission's PR state: some task's PR is open on record and not just written. */
export function missionPrStateStale(tasks: readonly PrStateRow[], now: number): boolean {
  return tasks.some(t => {
    const w = t.workers?.[0];
    return !!w?.prUrl && !settled(w) && !fresh(w, now);
  });
}

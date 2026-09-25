/**
 * "Did this PR's deliverable ship?" — the one predicate.
 *
 * `canCompleteMission`'s awaiting-merge gate and the `all_prs_merged` goal
 * criterion both ask it. They used to answer it separately: supersession
 * (a closed PR whose diff landed under a different, merged PR) was taught to
 * the gate and never to the criterion, so a mission could clear the gate and
 * still read FAIL on "N PR(s) not yet merged" forever. Both now call here.
 *
 * Shipped means merged, or closed with a supersession edge naming a merged PR.
 * Everything else — open, conflicted, CI-failing, closed with no edge — has
 * not shipped (the M4 rule, docs/specs/mission-task-lifecycle.md).
 */

export type PrShipState =
  /** No PR on this row — nothing to ship, nothing to block. */
  | 'no_pr'
  | 'merged'
  /** Closed unmerged, but the work landed under `supersededByPrNumber`. */
  | 'superseded'
  /** Not merged and not closed: merging it is the remedy. */
  | 'open'
  /** Closed unmerged with no edge: it never shipped, and GitHub won't reopen it. */
  | 'closed_unsuperseded';

export interface PrShipInput {
  prUrl?: string | null;
  mergedAt?: string | Date | null;
  prLifecycleStatus?: string | null;
  supersededByPrNumber?: number | null;
}

export function prShipState(w: PrShipInput | null | undefined): PrShipState {
  if (!w?.prUrl) return 'no_pr';
  if (w.mergedAt) return 'merged';
  // `recordPrSupersession` verifies the target is merged at write time, and a
  // merge is permanent — a stored edge is trusted without a GitHub round-trip.
  if (w.supersededByPrNumber) return 'superseded';
  if (w.prLifecycleStatus === 'closed') return 'closed_unsuperseded';
  return 'open';
}

/** True when the row has a PR and that PR's work shipped (merged or superseded). */
export function isPrShipped(w: PrShipInput | null | undefined): boolean {
  const s = prShipState(w);
  return s === 'merged' || s === 'superseded';
}

/** True when the row has a PR whose work has not shipped. */
export function isPrUnshipped(w: PrShipInput | null | undefined): boolean {
  const s = prShipState(w);
  return s === 'open' || s === 'closed_unsuperseded';
}

// ─── Lineage-derived supersession ────────────────────────────────────────────

export interface LineageTask {
  id: string;
  parentTaskId?: string | null;
  taskClass?: string | null;
}

export interface LineageWorker extends PrShipInput {
  taskId?: string | null;
  prNumber?: number | null;
  supersededByPrUrl?: string | null;
  supersededReason?: string | null;
}

export function prNumberOf(w: { prNumber?: number | null; prUrl?: string | null }): number | null {
  if (w.prNumber) return w.prNumber;
  const m = w.prUrl?.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return m ? Number(m[1]) : null;
}

/**
 * Root of a task's retry lineage: follow `parentTaskId` only while the row is
 * an `attempt` (CI retry, after-review builder, conflict retry). A spawned
 * builder under an approved plan also carries a parentTaskId but is its own
 * deliverable, so the walk stops at the first non-attempt.
 */
function lineageRoot(taskId: string, byId: Map<string, LineageTask>): string {
  let cur = taskId;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const t = byId.get(cur);
    if (!t || t.taskClass !== 'attempt' || !t.parentTaskId || !byId.has(t.parentTaskId)) return cur;
    cur = t.parentTaskId;
  }
  return cur;
}

/**
 * Fill in supersession the platform can prove on its own: a PR that closed
 * unmerged, followed in the SAME attempt lineage by a later PR that merged.
 * The platform opened that replacement itself (the attempt's parentTaskId
 * chain is written by the retry machinery, not asserted by an agent), so
 * requiring a manual `record_pr_supersession` for it was pure ceremony.
 *
 * Deliberately narrow, so the M4 rule still holds:
 *  - only `closed_unsuperseded` rows are touched — an OPEN PR is never
 *    superseded by a sibling, it is still awaiting merge;
 *  - the successor must be merged and carry a HIGHER PR number (GitHub
 *    numbers are monotonic per repo, so "later" needs no timestamp);
 *  - lineage is the attempt chain only — two independent deliverables that
 *    happen to share a mission never vouch for each other.
 *
 * Returns a copy of `workers`; derived rows get `supersededByPrNumber` set
 * and `supersessionDerived: true`. Recorded edges are left untouched.
 */
export function deriveLineageSupersession<W extends LineageWorker>(
  tasks: ReadonlyArray<LineageTask>,
  workers: ReadonlyArray<W>,
): Array<W & { supersessionDerived?: true }> {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const mergedByRoot = new Map<string, Array<{ n: number; url: string | null }>>();
  for (const w of workers) {
    if (!w.taskId || !w.prUrl || !w.mergedAt) continue;
    const n = prNumberOf(w);
    if (n == null) continue;
    const root = lineageRoot(w.taskId, byId);
    const list = mergedByRoot.get(root) ?? [];
    list.push({ n, url: w.prUrl });
    mergedByRoot.set(root, list);
  }

  return workers.map(w => {
    if (prShipState(w) !== 'closed_unsuperseded' || !w.taskId) return w;
    const n = prNumberOf(w);
    if (n == null) return w;
    const successors = (mergedByRoot.get(lineageRoot(w.taskId, byId)) ?? [])
      .filter(m => m.n > n)
      .sort((a, b) => a.n - b.n);
    if (successors.length === 0) return w;
    return {
      ...w,
      supersededByPrNumber: successors[0].n,
      supersededByPrUrl: w.supersededByPrUrl ?? successors[0].url,
      supersededReason: w.supersededReason
        ?? `derived: PR #${successors[0].n} from the same retry lineage merged after this one closed`,
      supersessionDerived: true as const,
    };
  });
}

// ─── Per-PR rollup ───────────────────────────────────────────────────────────

export interface PrShipSummary {
  prUrl: string;
  prNumber: number | null;
  state: Exclude<PrShipState, 'no_pr'>;
  supersededByPrNumber: number | null;
}

/**
 * Collapse worker rows to one verdict per PR. Several workers can carry the
 * same PR (a retry session pushing to the existing branch), and `mergedAt` or
 * a supersession edge is written on only one of them — judged row by row, the
 * others read as "not merged" for a PR that did merge. Any row's proof of
 * shipping counts for the PR.
 */
export function summarizePrShipStates(workers: ReadonlyArray<LineageWorker>): PrShipSummary[] {
  const RANK: Record<PrShipSummary['state'], number> = {
    merged: 0, superseded: 1, closed_unsuperseded: 2, open: 3,
  };
  const byUrl = new Map<string, PrShipSummary>();
  for (const w of workers) {
    const state = prShipState(w);
    if (state === 'no_pr') continue;
    const url = w.prUrl!;
    const prev = byUrl.get(url);
    const next: PrShipSummary = {
      prUrl: url,
      prNumber: prNumberOf(w),
      state,
      supersededByPrNumber: w.supersededByPrNumber ?? null,
    };
    if (!prev || RANK[state] < RANK[prev.state]) byUrl.set(url, next);
  }
  return [...byUrl.values()];
}

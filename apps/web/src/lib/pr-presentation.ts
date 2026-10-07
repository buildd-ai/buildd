/**
 * Canonical PR-lifecycle presentation vocabulary.
 *
 * Shared by every surface that shows a worker's pull-request state — the task
 * detail page, the mission task drawer (TaskPanel), and the mission timeline —
 * so a PR reads the same everywhere. CI state is webhook-fed onto the worker
 * row, so no live GitHub call is needed to decide whether a PR is safe to merge.
 */

export interface PrLifecyclePresentation {
  label: string;
  /** Tailwind bg + text classes for the pill. */
  cls: string;
}

/**
 * The display state of a PR from the two stored facts (`workers.mergedAt`,
 * `workers.prLifecycleStatus`). Every surface that says what state a PR is in
 * projects from this one mapping, into its own smaller vocabulary where it has
 * one — it never re-reads the lifecycle column itself.
 *
 *   mergedAt set (any lifecycle)  → merged        a merge stamp is the strongest fact
 *   merged                        → merged        webhook saw the merge, stamp not written yet
 *   closed                        → closed
 *   unresolvable                  → unresolvable  GitHub cannot answer for it (terminal)
 *   conflict                      → conflict
 *   ci_failed                     → ci_failed
 *   ci_running                    → ci_running
 *   ci_green                      → ci_passed
 *   pr_open                       → awaiting_ci   opened; no CI event recorded yet
 *   null / unknown                → open          a PR exists, nothing more is known
 *
 * Projections (the only places the mapping is narrowed):
 *   - chat PR object (`load-pr-object.ts`): awaiting_ci → open, unresolvable → closed
 *   - explain history (`explain.ts`): ci_running/ci_passed/awaiting_ci → open, unresolvable → closed
 *   - mission feed (`mission-pulse.ts`): awaiting_ci/ci_running → checks_running
 *     (the platform owns the next step), ci_passed → open
 */
export type PrDisplayState =
  | 'merged' | 'closed' | 'unresolvable' | 'conflict'
  | 'ci_failed' | 'ci_running' | 'ci_passed' | 'awaiting_ci' | 'open';

export function derivePrDisplayState(
  prLifecycleStatus: string | null | undefined,
  mergedAt: unknown,
): PrDisplayState {
  if (mergedAt) return 'merged';
  switch (prLifecycleStatus) {
    case 'merged': return 'merged';
    case 'closed': return 'closed';
    case 'unresolvable': return 'unresolvable';
    case 'conflict': return 'conflict';
    case 'ci_failed': return 'ci_failed';
    case 'ci_running': return 'ci_running';
    case 'ci_green': return 'ci_passed';
    case 'pr_open': return 'awaiting_ci';
    default: return 'open';
  }
}

/**
 * The display state of a PR, from the one source that owns it: the
 * delivery's own facts when the workflow kernel owns the PR
 * (`DeliveryView.prState`, workflow-state-kernel §17.5), else the fact-cache
 * columns through `derivePrDisplayState`. Every surface that needs a PR's
 * state for a row that may be kernel-owned calls this, never the columns.
 */
export function resolvePrDisplayState(input: {
  delivery?: { prState?: PrDisplayState | null } | null;
  prLifecycleStatus?: string | null;
  mergedAt?: unknown;
}): PrDisplayState {
  if (input.delivery?.prState) return input.delivery.prState;
  return derivePrDisplayState(input.prLifecycleStatus, input.mergedAt);
}

/** The lifecycle words `list_prs` speaks (the fact-cache column's own vocabulary). */
export type PrListStatus = 'pr_open' | 'ci_running' | 'ci_green' | 'ci_failed' | 'merged' | 'conflict' | 'closed' | 'unresolvable';

/**
 * Slice F (§13.10): a display state in the list's lifecycle words, so a
 * kernel-owned PR's row says what its delivery says. The inverse of
 * `derivePrDisplayState`: `open` (nothing known) is `null`.
 */
export function prListStatus(s: PrDisplayState): PrListStatus | null {
  switch (s) {
    case 'ci_passed': return 'ci_green';
    case 'awaiting_ci': return 'pr_open';
    case 'open': return null;
    default: return s;
  }
}

/** The supersession edge as the API reports it. */
export interface PrSupersededBy { prNumber: number | null; url: string | null; reason: string | null }

/** What a delivery says about the PR's ending (`DeliveryView` carries it). */
export interface DeliveryPrRecord {
  state: string;
  mergedAt: string | null;
  supersededBy: PrSupersededBy | null;
}

const isoOrNull = (v: unknown): string | null => (v == null || v === '' ? null : v instanceof Date ? v.toISOString() : String(v));

/**
 * Slice F (§13.10): whether the PR merged, when, and what superseded it, from
 * the one source that owns it. For a kernel-owned PR that is the delivery
 * (MERGED, its `merged_at`, its T20 record); the worker columns are not read.
 * A legacy PR keeps the fact cache: a merge stamp or a `merged` lifecycle.
 */
export function prRecord(input: {
  delivery?: DeliveryPrRecord | null;
  mergedAt?: unknown;
  prLifecycleStatus?: string | null;
  supersededByPrNumber?: number | null;
  supersededByPrUrl?: string | null;
  supersededReason?: string | null;
}): { merged: boolean; mergedAt: string | null; supersededBy: PrSupersededBy | null } {
  const d = input.delivery;
  if (d) return { merged: d.state === 'MERGED', mergedAt: d.mergedAt ?? null, supersededBy: d.supersededBy ?? null };
  const edge = input.supersededByPrNumber != null || input.supersededByPrUrl
    ? { prNumber: input.supersededByPrNumber ?? null, url: input.supersededByPrUrl ?? null, reason: input.supersededReason ?? null }
    : null;
  return { merged: !!input.mergedAt || input.prLifecycleStatus === 'merged', mergedAt: isoOrNull(input.mergedAt), supersededBy: edge };
}

/**
 * `get_pr`'s state: GitHub decides open versus closed. A closed PR whose
 * record says merged reads merged, because GitHub's `merged` flag can lag a
 * merge the record already holds.
 */
export function canonicalPrState(gh: { githubMerged: boolean; githubClosed: boolean }, recordMerged: boolean): 'open' | 'merged' | 'closed_unmerged' {
  if (gh.githubMerged || (recordMerged && gh.githubClosed)) return 'merged';
  return gh.githubClosed ? 'closed_unmerged' : 'open';
}

/** The pill for each display state: the only PR pill vocabulary. */
export const PR_PILL: Record<PrDisplayState, PrLifecyclePresentation> = {
  merged:       { label: 'Merged',       cls: 'bg-status-success/15 text-status-success' },
  ci_running:   { label: 'CI running',   cls: 'bg-status-info/15 text-status-info' },
  ci_failed:    { label: 'CI failing',   cls: 'bg-status-error/15 text-status-error' },
  ci_passed:    { label: 'CI passing',   cls: 'bg-status-success/15 text-status-success' },
  conflict:     { label: 'Conflict',     cls: 'bg-status-warning/15 text-status-warning' },
  closed:       { label: 'Closed',       cls: 'bg-text-muted/15 text-text-muted' },
  awaiting_ci:  { label: 'Open',         cls: 'bg-accent/15 text-accent-text' },
  open:         { label: 'Open',         cls: 'bg-accent/15 text-accent-text' },
  unresolvable: { label: 'Unresolvable', cls: 'bg-text-muted/15 text-text-muted' },
};

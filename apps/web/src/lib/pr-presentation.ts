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

export const PR_LIFECYCLE: Record<string, PrLifecyclePresentation> = {
  merged:     { label: 'Merged',     cls: 'bg-status-success/15 text-status-success' },
  ci_running: { label: 'CI running', cls: 'bg-status-info/15 text-status-info' },
  ci_failed:  { label: 'CI failing', cls: 'bg-status-error/15 text-status-error' },
  ci_green:   { label: 'CI passing', cls: 'bg-status-success/15 text-status-success' },
  conflict:   { label: 'Conflict',   cls: 'bg-status-warning/15 text-status-warning' },
  closed:     { label: 'Closed',     cls: 'bg-text-muted/15 text-text-muted' },
  pr_open:    { label: 'Open',       cls: 'bg-accent/15 text-accent-text' },
  unresolvable: { label: 'Unresolvable', cls: 'bg-text-muted/15 text-text-muted' },
};

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
 * Resolve the lifecycle pill for a worker's PR. `prLifecycleStatus` is the
 * webhook-fed column; when absent but a PR exists we fall back to "Open".
 * Returns null when there is no PR at all.
 */
export function derivePrLifecycle(
  prLifecycleStatus: string | null | undefined,
  hasPr: boolean,
): PrLifecyclePresentation | null {
  if (prLifecycleStatus && PR_LIFECYCLE[prLifecycleStatus]) return PR_LIFECYCLE[prLifecycleStatus];
  return hasPr ? PR_LIFECYCLE.pr_open : null;
}

/** True when the PR is merged — used to pick "View PR" vs "Review & merge" verbs. */
export function isPrMerged(prLifecycleStatus: string | null | undefined): boolean {
  return prLifecycleStatus === 'merged';
}

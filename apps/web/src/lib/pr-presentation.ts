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
  conflict:   { label: 'Conflict',   cls: 'bg-status-warning/15 text-status-warning' },
  closed:     { label: 'Closed',     cls: 'bg-text-muted/15 text-text-muted' },
  pr_open:    { label: 'Open',       cls: 'bg-accent/15 text-accent-text' },
};

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

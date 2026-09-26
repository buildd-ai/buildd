/**
 * Does a task result carry code deliverables? Commits or a PR. Every worker
 * gets a branch, so a branch alone (a visual audit, a research task that
 * pushed nothing) is not one and is not listed under Deliverables.
 */
export function hasCodeDeliverables(result: { commits?: number; prUrl?: string | null; branch?: string | null }): boolean {
  return (result.commits ?? 0) > 0 || !!result.prUrl;
}

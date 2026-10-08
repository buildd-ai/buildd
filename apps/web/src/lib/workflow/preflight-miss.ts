/**
 * §6.10 tier 3 (docs/specs/workflow-state-kernel.md, S31): CI stays the
 * backstop, and a CI failure whose check belongs to a preflight class is
 * tagged `preflight_miss` on the transition that records it, so the miss rate
 * of create_pr's and the runner's preflight is measurable. A tag only: it
 * changes no state, budget or dispatch.
 */

/** The built-in preflight class: the No Production Data workflow create_pr scans for. */
export const DEFAULT_PREFLIGHT_CI_CHECKS: readonly string[] = ['no production data', 'no-prod-data'];

/**
 * The first failing check or workflow name that a configured preflight class
 * matches (case-insensitive substring), or null. Unknown failures (`null`)
 * are never a miss.
 */
export function preflightMissOf(failing: string[] | null | undefined, ciChecks?: unknown): string | null {
  if (!failing?.length) return null;
  const classes = (Array.isArray(ciChecks) ? ciChecks : DEFAULT_PREFLIGHT_CI_CHECKS)
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    .map((c) => c.trim().toLowerCase());
  return failing.find((name) => classes.some((c) => name.toLowerCase().includes(c))) ?? null;
}

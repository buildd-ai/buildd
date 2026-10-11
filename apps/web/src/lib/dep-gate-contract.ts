/**
 * Shared dependency-gate contract.
 *
 * The claim route enforces the gate in SQL (`api/workers/claim/deps-gate.ts`);
 * the display layer enforces it in TypeScript (`lib/task-presentation.ts`).
 * Both import from here so the two cannot drift — the divergence this module
 * exists to prevent shipped phantom blockers: the UI showed tasks BLOCKED on
 * cancelled deps and on completed deps whose PR had been closed, while the
 * claim route considered both satisfied.
 *
 * This module must stay dependency-free — it is imported by client components.
 */

/**
 * Dependency statuses that SATISFY (unblock) a dependent task.
 *
 *   - `completed` — the delivered path (an open/unmerged PR still blocks; see below).
 *   - `cancelled` — an intentional "this won't be delivered" signal. Cancelling a
 *     dead/abandoned dependency is a deliberate act; its dependents should proceed
 *     rather than be gated forever.
 *
 * Any other status — notably `failed`, `pending`, `in_progress` — remains BLOCKING.
 */
export const DEP_SATISFYING_STATUSES = ['completed', 'cancelled'] as const;

/**
 * PR lifecycle status that releases the open-PR guard on a `completed` dep.
 * A closed/abandoned PR means the work will never land, so holding dependents
 * behind it blocks them forever.
 */
export const DEP_UNBLOCKING_PR_LIFECYCLE = 'closed';

/**
 * `dependency_releases.decision` values that satisfy a dependency ahead of
 * the upstream's own status/PR state — docs/design/early-release.md "Data
 * model". A dependent is also unblocked when a non-revoked release row names
 * it as the dependent and the upstream as the dependency, with one of these
 * decisions:
 *
 *   - `start_now` — claim immediately, off trunk.
 *   - `start_stacked` — claim immediately, off the upstream's branch.
 *
 * `wait` deliberately is NOT here: it is a recorded decision to keep the
 * dependsOn gate closed, not a release. This arm is purely additive to the
 * `completed` + no-open-PR check in `dependencySatisfied()` — a workspace
 * that never writes a `dependency_releases` row sees no behavior change.
 */
export const EARLY_RELEASE_SATISFYING_DECISIONS = ['start_now', 'start_stacked'] as const;

/**
 * PR lifecycle states nothing can move a worker out of: the PR merged, closed,
 * or is `unresolvable` (GitHub cannot answer for it — see `lib/pr-freshness.ts`).
 * Re-asking GitHub cannot change any of them, and a later CI event must not
 * overwrite them. Every "is this PR done" read uses this one set: the webhook's
 * check-event guard, the refresh and reconcile sweeps, and the create_pr dedup.
 */
export const TERMINAL_PR_LIFECYCLE = ['merged', 'closed', 'unresolvable'] as const;
export type TerminalPrLifecycle = (typeof TERMINAL_PR_LIFECYCLE)[number];

export function isTerminalPrLifecycle(status: string | null | undefined): status is TerminalPrLifecycle {
  return status != null && (TERMINAL_PR_LIFECYCLE as readonly string[]).includes(status);
}

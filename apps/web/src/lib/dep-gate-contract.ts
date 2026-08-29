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

/**
 * The PR vocabulary the kernel's read model speaks. apps/web's
 * `pr-presentation.ts` re-exports these, so there is one definition; the
 * mapping from stored worker columns (`derivePrDisplayState`) stays there.
 */

/** The display state of a PR (see `derivePrDisplayState` in apps/web for the mapping). */
export type PrDisplayState =
  | 'merged' | 'closed' | 'unresolvable' | 'conflict'
  | 'ci_failed' | 'ci_running' | 'ci_passed' | 'awaiting_ci' | 'open';

/** The supersession edge as the API reports it. */
export interface PrSupersededBy { prNumber: number | null; url: string | null; reason: string | null }

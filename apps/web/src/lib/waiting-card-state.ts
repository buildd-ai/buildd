export type WaitingCardState = 'full' | 'merged_resolved' | 'closed_warning';

/**
 * Resolves how a waiting-on-you merge card should render based on the
 * persisted prLifecycleStatus field (read from workers.prLifecycleStatus).
 *
 * Null/unknown MUST fall back to 'full' — never false-collapse on missing data.
 * See docs/design/mobile-decision-flow.md §1.3.
 */
export function resolveWaitingCardState(
  prLifecycleStatus: string | null | undefined,
): WaitingCardState {
  if (prLifecycleStatus === 'merged') return 'merged_resolved';
  if (prLifecycleStatus === 'closed') return 'closed_warning';
  return 'full';
}

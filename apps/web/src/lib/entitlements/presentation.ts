/**
 * Copy for an entitlement block: what limit is reached, that the task is
 * queued (not failed), and what lifts it. One function per block kind, so a
 * new commercial limit adds a case here and reuses EntitlementBlockedNotice.
 *
 * Kept apart from the gate-refusal copy in lib/task-actions.ts on purpose: a
 * gate refusal is something wrong with the task; this is the plan.
 */
import type { EntitlementBlock } from '@buildd/shared';

export interface EntitlementCopy {
  /** Short state word, for the chip. */
  state: string;
  title: string;
  body: string;
  /** Primary action label. */
  upgradeLabel: string;
  /** One fact the reader may confuse this with. */
  footnote: string;
}

const SELF_HOSTED_NOTE = 'Your own runners are not limited by your plan.';

function hours(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** `formatDate` turns the refill ISO into a reader-local date; defaults to e.g. "Nov 1". */
export function describeEntitlementBlock(
  block: EntitlementBlock,
  formatDate: (iso: string) => string = (iso) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
): EntitlementCopy {
  switch (block.kind) {
    case 'concurrency': {
      const shared = block.scope === 'team' ? ', shared across your team' : '';
      return {
        state: 'Queued',
        title: `${block.active} managed ${block.active === 1 ? 'run' : 'runs'} already active`,
        body: `Your plan includes up to ${block.limit} at once${shared}. This task will start automatically when one finishes.`,
        upgradeLabel: 'Upgrade parallel capacity',
        footnote: SELF_HOSTED_NOTE,
      };
    }
    case 'usage':
      return {
        state: 'Queued',
        title: `Monthly runner-hours used: ${hours(block.used)} of ${hours(block.limit)}`,
        body: `Managed runs are paused for this month. This task will start automatically when hours refill on ${formatDate(block.resetsAt)}, or as soon as you add more.`,
        upgradeLabel: 'Add runner-hours',
        footnote: SELF_HOSTED_NOTE,
      };
  }
}

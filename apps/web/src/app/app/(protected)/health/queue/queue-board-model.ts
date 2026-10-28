/**
 * Health › Queue's view, mapped onto the shared components' props (spec
 * 4bc3e70e r8: R-3, R-5 to R-8). Pure: every number and word comes from the
 * one read (lib/health-queue.ts); this only renames the view's fields to the
 * props QueueTiles, QueueRow, DeliveryRow and StageMeter take.
 */
import type { HealthQueueReadyRow, HealthQueueReason, HealthQueueResponse, HealthQueueTiles, HealthQueueWaitingRow } from '@buildd/shared';
import type { ChipTone } from '@/components/ui/Chip';
import type { QueueReason, QueueTilesProps } from '@/components/health/QueueTiles';
import type { DeliveryItem } from '@/components/ui/DeliveryRow';

export const QUEUE_ANCHORS = { queued: 'queue-ready', blocked: 'queue-waiting', scheduled: 'queue-parked' } as const;

/** The view's Declared is the shared components' Dependency (terms catalog `queue.dependency`). */
export const REASON_OF: Record<HealthQueueReason, QueueReason> = { lane: 'lane', limit: 'limit', declared: 'dependency' };

/**
 * The Running tile's numbers: slots in use and slots in total, the same pair
 * the Capacity block on Runners shows (R-3, AC-14). Total is team-wide (R-2).
 */
export function runningOf(tiles: HealthQueueTiles): QueueTilesProps['running'] {
  return tiles.capacity;
}

export function queueTilesProps(view: HealthQueueResponse): Omit<QueueTilesProps, 'layout' | 'className'> {
  const { tiles } = view;
  return {
    running: runningOf(tiles),
    queued: tiles.ready,
    blocked: { lane: tiles.waitingByReason.lane, limit: tiles.waitingByReason.limit, dependency: tiles.waitingByReason.declared },
    scheduled: tiles.parked,
    hrefs: {
      running: '/app/health/runners',
      queued: `#${QUEUE_ANCHORS.queued}`,
      blocked: `#${QUEUE_ANCHORS.blocked}`,
      scheduled: `#${QUEUE_ANCHORS.scheduled}`,
    },
  };
}

/** A Dependency row's blocker, as the square status dot QueueRow draws. */
export function blockerDot(status: string | null): ChipTone | undefined {
  switch (status) {
    case 'in_progress':
    case 'assigned': return 'running';
    case 'review':
    case 'completed': return 'success';
    case 'failed': return 'error';
    case 'pending': return 'muted';
    default: return undefined;
  }
}

/** Which action a Blocked row offers (R-20): Force start on a forceable Limit, Start anyway on a Dependency. */
export type QueueRowAction = 'force_start' | 'start_anyway' | null;

export function rowAction(row: HealthQueueWaitingRow): QueueRowAction {
  if (row.reason === 'limit') return row.forceable ? 'force_start' : null;
  if (row.reason === 'declared') return 'start_anyway';
  return null;
}

/** A Queued row as a DeliveryRow: not started, so its meter sits dashed at Build. */
export function readyDelivery(row: HealthQueueReadyRow): DeliveryItem {
  const at = Date.parse(row.createdAt);
  return {
    id: row.id,
    title: row.title,
    href: `/app/tasks/${row.id}`,
    updatedAt: Number.isFinite(at) ? at : 0,
    meter: { state: 'queued', stage: 'build' },
    missionTitle: row.missionTitle,
    failingCheck: null,
  };
}

/** Blocked filter chips with their counts, in R-6's order after All. */
export function filterItems(tiles: HealthQueueTiles): Array<{ value: 'all' | HealthQueueReason; reason: QueueReason | null; count: number }> {
  return [
    { value: 'all', reason: null, count: tiles.waiting },
    { value: 'lane', reason: 'lane', count: tiles.waitingByReason.lane },
    { value: 'limit', reason: 'limit', count: tiles.waitingByReason.limit },
    { value: 'declared', reason: 'dependency', count: tiles.waitingByReason.declared },
  ];
}

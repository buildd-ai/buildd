/**
 * Failure Pattern Sentinel reactions to core events (lib/core-events.ts).
 * Core emits the fact; this owns the reaction. Order and the composition
 * root: apps/web/src/modules.ts.
 *
 * - `task.terminal`: a task's outcome settled (not going back to the queue),
 *   so a bounded, debounced, single-workspace sweep may now see a new pattern.
 *   `scheduleFailurePatternSentinel` defers past the response and never
 *   throws; the 30-minute cron backstop covers a sweep that never ran.
 */
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { scheduleFailurePatternSentinel } from '@/lib/failure-pattern-sentinel-trigger';

export const failurePatternSubscribers: readonly AnySubscriber[] = [
  subscriber('health-quality', 'task.terminal', 'failure-pattern-sentinel', e => {
    if (e.workspaceId) scheduleFailurePatternSentinel(e.workspaceId);
  }),
];

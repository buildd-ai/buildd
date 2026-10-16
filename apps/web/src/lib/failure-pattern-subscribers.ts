/**
 * Failure Pattern Sentinel reactions to core events (lib/core-events.ts).
 * Core emits the fact; this owns the reaction. Order and the composition
 * root: apps/web/src/modules.ts.
 *
 * - `task.terminal`: a task's outcome settled (not going back to the queue),
 *   so a bounded, debounced, single-workspace sweep may now see a new pattern.
 *   `scheduleFailurePatternSentinel` defers past the response and never
 *   throws; the 30-minute cron backstop covers a sweep that never ran.
 * - `pr.closed` (merged or not): the moment a path-overlap stall behind that
 *   PR can recover, so the open incidents naming it are re-assessed now
 *   (failure-incident-recovery §12(a)), not at the next backstop sweep. Run
 *   after the response, behind the merge work's own `releaseAndNotify`, so a
 *   release the merge already did is seen, not repeated (and a repeat is
 *   idempotent anyway). Never throws.
 */
import { after } from 'next/server';
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { scheduleFailurePatternSentinel } from '@/lib/failure-pattern-sentinel-trigger';

async function reassessAfterResponse(workspaceId: string, prNumber: number): Promise<void> {
  const run = () => import('@/lib/failure-pattern-sweep')
    .then(m => m.reassessIncidentsNamingPr(workspaceId, prNumber, 'merge_hook'))
    .then(() => {})
    .catch(err => console.error(`[failure-pattern] re-assess for PR #${prNumber} failed:`, err));
  try {
    after(run);
  } catch {
    await run(); // no request scope (the effect drain, tests)
  }
}

export const failurePatternSubscribers: readonly AnySubscriber[] = [
  subscriber('health-quality', 'task.terminal', 'failure-pattern-sentinel', e => {
    if (e.workspaceId) scheduleFailurePatternSentinel(e.workspaceId);
  }),
  subscriber('health-quality', 'pr.closed', 'failure-incident-recovery-on-pr-closed', e =>
    reassessAfterResponse(e.workspaceId, e.prNumber)),
];

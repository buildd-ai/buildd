/**
 * Outcome analytics for a release the worker PATCH held for CI.
 *
 * The PATCH records the routing-outcome row and the runner failure detector
 * itself when a report settles the task. A held release is not settled: the
 * PATCH keeps the row it would have written on the task, and when the release
 * PR's CI resolves it (`via: 'release'`, lib/task-outcome-event.ts) this
 * records that row with the release's outcome. Once per resolution;
 * fire-and-forget like the PATCH's own calls.
 */
import { recordTaskOutcome } from '@buildd/core/routing-analytics';
import { recordRunnerOutcome } from '@buildd/core/runner-health';
import { subscriber, type AnySubscriber, type EventOf } from '@/lib/core-events';

function recordReleaseOutcome(e: EventOf<'task.completed' | 'task.failed'>, outcome: 'completed' | 'failed'): void {
  if (e.via !== 'release') return;
  // A task held before the PATCH kept its row still records the outcome,
  // with what the task row can tell (recordTaskOutcome reads the rest).
  const row = e.heldAnalytics ?? { workerId: e.workerId };
  recordTaskOutcome({ ...row, taskId: e.taskId, outcome }).catch(() => {});
  recordRunnerOutcome(outcome).catch(() => {});
}

export const routingAnalyticsSubscribers: readonly AnySubscriber[] = [
  subscriber('health-quality', 'task.completed', 'release-outcome-analytics-completed', e => recordReleaseOutcome(e, 'completed')),
  subscriber('health-quality', 'task.failed', 'release-outcome-analytics-failed', e => recordReleaseOutcome(e, 'failed')),
];

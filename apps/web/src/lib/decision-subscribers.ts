/**
 * Decisions module (Jev): the decision model's looks that a core fact sets off.
 *
 * `task.created`: the category look (lib/task-category-decision.ts). Scheduled
 * with `after()`, so it runs once the response is out and cannot delay or fail
 * creation; outside a request scope it runs at once. It may fill or replace a
 * keyword category, never a filer's own. An attached filing is not a new task,
 * so there is nothing to look at.
 *
 * `pr.close_delivered`: merge readiness decisions on the PR get their outcome
 * label (lib/merge-readiness-decision-outcomes.ts). GitHub reads, so `after()`.
 * `sweep.pr_hourly` is the backstop for a lost delivery, and attaches the
 * revert labels. Both idempotent.
 */
import { after } from 'next/server';
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { scheduleTaskCategorize } from '@/lib/task-category-decision';
import type { TaskCategoryValue } from '@buildd/shared';

export const decisionSubscribers: readonly AnySubscriber[] = [
  subscriber('jev-decisions', 'task.created', 'task-category-look', e => {
    if (e.attached) return;
    scheduleTaskCategorize({
      taskId: e.taskId,
      teamId: e.teamId,
      workspaceId: e.workspaceId,
      accountId: e.creator.accountId,
      title: e.title,
      description: e.description,
      stored: e.category.stored as TaskCategoryValue | null,
      callerSet: e.category.callerSet,
      dataClass: e.dataClass,
    }, after);
  }),
  subscriber('jev-decisions', 'pr.close_delivered', 'merge-readiness-outcome', e => {
    if (e.installationId == null) return;
    const run = () => import('@/lib/merge-readiness-decision-outcomes-store')
      .then(m => m.attachMergeReadinessOutcomesOnClose(e))
      .then(() => undefined, err => console.warn('[merge-readiness-outcomes] close label failed (non-fatal):', err));
    try {
      after(run);
    } catch {
      // after() is unavailable outside a request scope (tests): run inline, unawaited.
      void run();
    }
  }),
  subscriber('jev-decisions', 'sweep.pr_hourly', 'merge-readiness-outcome-sweep', async e => {
    const { sweepMergeReadinessOutcomes } = await import('@/lib/merge-readiness-decision-outcomes-store');
    const r = await sweepMergeReadinessOutcomes(e.at);
    console.log(`[MergeReadinessOutcomes] prs=${r.prs} recorded=${r.recorded} errors=${r.errors} revertsChecked=${r.reverts.checked} reverted=${r.reverts.reverted} notReverted=${r.reverts.notReverted}`);
  }),
];

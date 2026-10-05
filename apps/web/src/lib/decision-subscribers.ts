/**
 * Decisions module (Jev): the decision model's looks that a core fact sets off.
 *
 * `task.created`: the category look (lib/task-category-decision.ts). Scheduled
 * with `after()`, so it runs once the response is out and cannot delay or fail
 * creation; outside a request scope it runs at once. It may fill or replace a
 * keyword category, never a filer's own. An attached filing is not a new task,
 * so there is nothing to look at.
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
];

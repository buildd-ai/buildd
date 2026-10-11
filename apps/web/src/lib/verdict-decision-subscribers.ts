/**
 * Task verdict module: recompute the cached verdict decision when, and only
 * when, a task's state changes (lib/task-verdict-decision-refresh.ts).
 *
 *   task.terminal       the worker's terminal report settled the task; a CI-fix
 *                       attempt ending also re-judges the task it was fixing
 *   pr.ci_failed /      a CI result on the task's PR
 *   pr.ci_passed
 *   pr.synchronized     a push to the PR (a fix attempt's commit)
 *   task.pr_merged /    a PR event
 *   pr.closed
 *
 * Every look is scheduled with `after()`: it runs once the response (or the
 * webhook's 200) is out and can never delay or fail the request it rode in
 * on. Outside a request scope it runs at once. Last in the subscriber list,
 * so the evidence record (knowledge module, task.terminal) is already written.
 */
import { after } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { workerOwnsPr } from '@/lib/repo-scope';
import { refreshTaskVerdict, type VerdictTrigger } from '@/lib/task-verdict-decision-refresh';

type Schedule = (task: () => Promise<void>) => void;

/** Never lets a failure out: a verdict look must not fail the request it rode in on. */
async function contained(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn('[task-verdict] state-change look failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

function scheduleWith(schedule: Schedule = after): (fn: () => Promise<void>) => void {
  return fn => {
    try {
      schedule(() => contained(fn));
    } catch {
      // No request scope (a script, a test): run now, still contained.
      void contained(fn);
    }
  };
}

/** Refresh a task and, when it is an attempt at another task, that task too. */
export async function refreshWithParent(taskId: string, trigger: VerdictTrigger): Promise<void> {
  await refreshTaskVerdict(taskId, trigger);
  const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { parentTaskId: true } });
  if (row?.parentTaskId) await refreshTaskVerdict(row.parentTaskId, 'attempt_end');
}

async function taskOfPr(repoFullName: string, prNumber: number): Promise<string | null> {
  const w = await db.query.workers.findFirst({
    where: workerOwnsPr(repoFullName, prNumber),
    orderBy: desc(workers.createdAt),
    columns: { taskId: true },
  });
  return w?.taskId ?? null;
}

export function verdictSubscribersWith(schedule?: Schedule): readonly AnySubscriber[] {
  const run = scheduleWith(schedule);
  const onPr = (trigger: VerdictTrigger) => (e: { repoFullName: string; prNumber: number }) =>
    run(async () => {
      const taskId = await taskOfPr(e.repoFullName, e.prNumber);
      if (taskId) await refreshTaskVerdict(taskId, trigger);
    });
  return [
    subscriber('jev-decisions', 'task.terminal', 'verdict-on-terminal', e => run(() => refreshWithParent(e.taskId, 'worker_terminal'))),
    subscriber('jev-decisions', 'pr.ci_failed', 'verdict-on-ci-failed', onPr('ci_result')),
    subscriber('jev-decisions', 'pr.ci_passed', 'verdict-on-ci-passed', onPr('ci_result')),
    subscriber('jev-decisions', 'pr.synchronized', 'verdict-on-push', e => {
      const taskId = e.worker.taskId;
      if (taskId) run(async () => { await refreshTaskVerdict(taskId, 'pr_event'); });
    }),
    subscriber('jev-decisions', 'task.pr_merged', 'verdict-on-merge', e => run(async () => { await refreshTaskVerdict(e.taskId, 'pr_event'); })),
    subscriber('jev-decisions', 'pr.closed', 'verdict-on-close', e => {
      if (e.taskId) {
        const taskId = e.taskId;
        run(async () => { await refreshTaskVerdict(taskId, 'pr_event'); });
      }
    }),
  ];
}

export const verdictSubscribers: readonly AnySubscriber[] = verdictSubscribersWith();

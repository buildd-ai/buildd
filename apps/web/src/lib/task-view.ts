/**
 * One read of a task's workers and open question, shared by the task page
 * (/app/tasks/[id]) and the sheet (/api/tasks/[id]/summary), so both show the
 * same worker and the same question for the same task.
 *
 * `pickTaskView` is pure: workers are ordered by `createdAt`, then `id`
 * (lib/attempt-order), never by the order a query returned them. The worker a
 * surface shows is the newest live one, else the newest of all. Its question is
 * dropped once the task has ended or a failure recovery owns the next step.
 */
import { db } from '@buildd/core/db';
import { workers, missionNotes } from '@buildd/core/db/schema';
import { and, asc, desc, eq } from 'drizzle-orm';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { isLiveWorkerStatus, isTerminalTaskStatus } from '@buildd/shared';
import { selectTaskWorkers, type Chrono } from '@/lib/attempt-order';
import { isOpenAsk, isOpenQuestionNote } from '@/lib/open-ask';
import { loadTaskRecoveryViewsForViewer } from '@/lib/incident-recovery-load';
import type { TaskRecoveryView } from '@/lib/incident-recovery-refs';
import { linkQuestionNote, type QuestionNoteLike } from '@/app/app/(protected)/tasks/[id]/question-hero';

type ViewWorker = Chrono & { status: string; waitingFor?: unknown; prUrl?: string | null; prNumber?: number | null };

export function pickTaskView<W extends ViewWorker, N extends QuestionNoteLike, R extends { supersedesQuestion?: boolean } = { supersedesQuestion?: boolean }>(input: {
  task: { status: string };
  workers: readonly W[];
  openQuestions: readonly N[];
  recovery?: R | null;
}) {
  const { task, recovery } = input;
  const picks = selectTaskWorkers(input.workers, isLiveWorkerStatus);
  // Never revive an ended worker merely because it retained a question.
  const liveRow = !isTerminalTaskStatus(task.status) ? picks.activeWorker : undefined;
  const mask = <T extends ViewWorker>(row: T | undefined): T | undefined =>
    row?.waitingFor && (!isOpenAsk(task.status, row.status) || recovery?.supersedesQuestion)
      ? { ...row, waitingFor: null }
      : row;
  const activeWorker = mask(liveRow);
  const shownWorker = activeWorker ?? mask(picks.latestWorker);
  const openQuestions = [...input.openQuestions];
  return {
    ordered: picks.ordered,
    latestWorker: picks.latestWorker,
    prWorker: picks.prWorker,
    activeWorker,
    shownWorker,
    openQuestions,
    questionNote: activeWorker?.waitingFor ? linkQuestionNote(openQuestions, activeWorker.id) : null,
    openQuestionCount: openQuestions.filter(n => isOpenQuestionNote(n, task.status, activeWorker)).length,
    recovery: recovery ?? null,
  };
}

/**
 * The task's workers (with their account), its open question notes and any
 * recovery holding it, read in one wait, then picked by `pickTaskView`.
 * Call it after the access check: it reads the task's workers.
 */
export async function loadTaskView(
  task: { id: string; status: string },
  viewer: { userId: string | null; teamId: string | null },
) {
  const [workerRows, openQuestions, recoveryViews] = await Promise.all([
    db.query.workers.findMany({
      where: sqlWhere(eq(workers.taskId, task.id)),
      orderBy: sqlOrderBy([desc(workers.createdAt), desc(workers.id)]),
      with: { account: { columns: { name: true, authType: true } } },
    }),
    db.query.missionNotes.findMany({
      where: sqlWhere(and(
        eq(missionNotes.taskId, task.id),
        eq(missionNotes.type, 'question'),
        eq(missionNotes.status, 'open'),
      )),
      orderBy: sqlOrderBy(asc(missionNotes.createdAt)),
      columns: { id: true, workerId: true, type: true, status: true, title: true, body: true, defaultChoice: true, createdAt: true },
    }),
    loadTaskRecoveryViewsForViewer([task.id], viewer),
  ]);
  const recovery: TaskRecoveryView | null = recoveryViews.get(task.id) ?? null;
  return pickTaskView({ task, workers: workerRows ?? [], openQuestions: openQuestions ?? [], recovery });
}

export type TaskView = Awaited<ReturnType<typeof loadTaskView>>;

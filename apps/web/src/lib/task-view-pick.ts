/**
 * `pickTaskView`: which worker and question a surface shows for a task. Pure,
 * with no database import, so the mission board (a client bundle) uses the
 * same pick as the task page and the sheet (lib/task-view.ts loads for them).
 *
 * Workers are ordered by `createdAt`, then `id` (lib/attempt-order), never by
 * the order a query returned them. The worker shown is the newest live one,
 * else the newest of all. Its question is dropped once the task has ended or a
 * failure recovery owns the next step.
 */
import { isLiveWorkerStatus, isTerminalTaskStatus } from '@buildd/shared';
import { selectTaskWorkers, type Chrono } from '@/lib/attempt-order';
import { isOpenAsk, isOpenQuestionNote } from '@/lib/open-ask';
import { linkQuestionNote, type QuestionNoteLike } from '@/app/app/(protected)/tasks/[id]/question-hero';

export type ViewWorker = Chrono & { status: string; waitingFor?: unknown; prUrl?: string | null; prNumber?: number | null };

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


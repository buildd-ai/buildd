import { isTerminalTaskStatus } from '@buildd/shared';

/** An ask belongs to a waiting worker on a task that can still continue. */
export function isOpenAsk(taskStatus: string | null | undefined, workerStatus: string | null | undefined): boolean {
  return !!taskStatus && !isTerminalTaskStatus(taskStatus) && workerStatus === 'waiting_input';
}

export function isOpenQuestionNote(
  note: { status: string; workerId?: string | null },
  taskStatus: string,
  worker: { id: string; status: string } | null | undefined,
): boolean {
  return note.status === 'open' && !!worker && isOpenAsk(taskStatus, worker.status)
    && (!note.workerId || note.workerId === worker.id);
}

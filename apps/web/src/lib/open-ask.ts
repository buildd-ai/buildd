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

/** One open question on a mission task: the shared accessor's `openQuestions` input. */
export interface MissionOpenQuestion {
  taskId: string;
  title: string | null;
  /** The question as asked, or null when the worker parked without one. */
  prompt: string | null;
}

/**
 * Every task in the mission whose worker is parked on a question for a person
 * (`isOpenAsk`), runner-managed or an interactive session's `ask_human` alike.
 * A waiting worker is still a live worker (`LIVE_WORKER_STATUSES`), so without
 * this the accessor reads the parked task as work in progress.
 */
export function missionOpenQuestions(
  rows: ReadonlyArray<{
    id: string;
    title?: string | null;
    status: string;
    workers?: ReadonlyArray<{ status: string; waitingFor?: unknown }> | null;
  }>,
): MissionOpenQuestion[] {
  const out: MissionOpenQuestion[] = [];
  for (const t of rows) {
    const w = (t.workers ?? []).find(x => isOpenAsk(t.status, x.status));
    if (!w) continue;
    const wf = w.waitingFor as { prompt?: unknown } | null | undefined;
    const prompt = typeof wf?.prompt === 'string' && wf.prompt.trim() ? wf.prompt.trim() : null;
    out.push({ taskId: t.id, title: t.title ?? null, prompt });
  }
  return out;
}

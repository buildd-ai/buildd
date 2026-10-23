import { isLiveWorkerStatus, isOpenTaskStatus, isTerminalTaskStatus } from '@buildd/shared';

/** An ask belongs to a waiting worker on a task that can still continue. */
export function isOpenAsk(taskStatus: string | null | undefined, workerStatus: string | null | undefined): boolean {
  return !!taskStatus && !isTerminalTaskStatus(taskStatus) && workerStatus === 'waiting_input';
}

/** Why the run (task and worker) something is bound to has ended, if it has. */
export type RunClosure = 'task_terminal' | 'worker_not_live';

/**
 * Has the run a capability request or grant belongs to ended? A grant lives
 * and dies with its run, so this one rule decides a use, an approval, and
 * whether a person is shown a request as open. A missing or unknown status
 * reads as ended: fail closed, never open.
 */
export function runClosure(taskStatus: string | null | undefined, workerStatus: string | null | undefined): RunClosure | null {
  if (!isOpenTaskStatus(taskStatus)) return 'task_terminal';
  if (!isLiveWorkerStatus(workerStatus)) return 'worker_not_live';
  return null;
}

/**
 * An access request's `isOpenAsk`: open for a person to decide only while it
 * is pending on a run that has not ended. The agent keeps working while it
 * waits, so its worker is live rather than `waiting_input`. Every surface that
 * offers Approve or Deny, or counts a request as waiting, reads it here.
 */
export function isOpenAccessRequest(status: string, taskStatus: string | null | undefined, workerStatus: string | null | undefined): boolean {
  return status === 'pending' && runClosure(taskStatus, workerStatus) === null;
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
  /**
   * Set when the park is `recovered`: the question gate filed this repair
   * task instead of asking, and the task resumes when it completes. Not a
   * question for a person (`admitsToNeedsYou` never admits it).
   */
  repairTaskId: string | null;
}

/** The repair a parked question waits on, when its disposition is `recovered`. */
export function recoveredRepairTaskId(waitingFor: unknown): string | null {
  const wf = waitingFor as { disposition?: unknown; repairTaskId?: unknown } | null | undefined;
  return wf?.disposition === 'recovered' && typeof wf.repairTaskId === 'string' && wf.repairTaskId ? wf.repairTaskId : null;
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
    out.push({ taskId: t.id, title: t.title ?? null, prompt, repairTaskId: recoveredRepairTaskId(w.waitingFor) });
  }
  return out;
}

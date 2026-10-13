/**
 * Answer a waiting agent: the one path every answer surface shares
 * (TaskQuestion on the task page, the mission task sheet, the Board and the
 * timeline, plus the chat feed's question card). Posts to
 * `/api/workers/[id]/respond` (which resumes or continues the session) and
 * marks the same ask's question note answered.
 *
 * A reply saying the question was already answered is an outcome, not an
 * error: the answer is recorded, and the surface shows what it was.
 */
import type { NotWaitingReason } from '@/lib/answer-resume';

export interface SubmitAnswerInput {
  workerId: string;
  /** Needed only to mark the question note answered. */
  taskId?: string | null;
  noteId?: string | null;
  message: string;
}

export type AnswerOutcome =
  | {
      kind: 'sent';
      /** What was sent. */
      answer: string;
      /** Where the work now is: the same task on a resume, a new one on a cold continuation. */
      taskId: string | null;
      /** `resume` | `cold_continuation`, as the server decided. */
      path: string | null;
      /** The server's sentence for the path it took. */
      message: string | null;
    }
  | {
      kind: 'already_answered';
      /** What was just tapped or typed. */
      answer: string;
      /** What the question was answered with, when the server could say. */
      recordedAnswer: string | null;
      /** The recorded answer is known and is not the one just tapped. */
      differs: boolean;
      /** The follow-up task the earlier answer moved the work to, when the server names one. */
      followUpTaskId?: string | null;
      taskId: null;
      path: null;
      message: string | null;
    };

/**
 * A failure. Without `stale` the question is still open and the answer can be
 * retried; with it, the agent stopped waiting after the card rendered.
 */
export class AnswerSubmitError extends Error {
  readonly credentialRevoked: boolean;
  readonly stale: StaleAnswerNotice | null;
  constructor(message: string, opts: { credentialRevoked?: boolean; stale?: StaleAnswerNotice | null } = {}) {
    super(message);
    this.name = 'AnswerSubmitError';
    this.credentialRevoked = opts.credentialRevoked === true;
    this.stale = opts.stale ?? null;
  }
}

const STALE_REASONS: ReadonlySet<string> = new Set<NotWaitingReason>(['already_answered', 'worker_ended', 'no_longer_waiting']);

export interface StaleAnswerNotice {
  message: string;
  href: string | null;
  linkLabel: string | null;
}

/**
 * /respond's reply when the card being answered is stale: the worker stopped
 * waiting after the card rendered. Null for every other rejection (e.g. a
 * revoked credential), where the question is still open and the answer can
 * be retried in place.
 */
export function staleAnswerNotice(data: unknown, taskId: string | null): StaleAnswerNotice | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { error?: unknown; reasonCode?: unknown; nextAction?: { kind?: string; taskId?: string } };
  if (typeof d.reasonCode !== 'string' || !STALE_REASONS.has(d.reasonCode)) return null;
  const message = typeof d.error === 'string' ? d.error : 'Already answered.';
  const next = d.nextAction;
  if (next?.kind === 'open_task' && typeof next.taskId === 'string') {
    return { message, href: `/app/tasks/${next.taskId}`, linkLabel: 'Open the follow-up task' };
  }
  if (next?.kind === 'follow_up' && taskId) {
    return { message, href: `/app/tasks/${taskId}`, linkLabel: 'Retry or start a follow-up from this task' };
  }
  return { message, href: null, linkLabel: null };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What a `/respond` reply means for the card. Pure. Already answered is the
 * `already_answered` reason code, or (from a server that predates it) a 409
 * saying so; a revoked-credential 409 stays an error.
 */
export function classifyRespondReply(
  status: number,
  data: unknown,
  answer: string,
): AnswerOutcome | { kind: 'error'; message: string; credentialRevoked: boolean } {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  if (status >= 200 && status < 300) {
    return { kind: 'sent', answer, taskId: str(d.taskId), path: str(d.path), message: str(d.message) };
  }
  const error = str(d.error);
  const alreadyAnswered = d.reasonCode === 'already_answered'
    || (status === 409 && d.credentialRevoked !== true && /already answered/i.test(error ?? ''));
  if (alreadyAnswered) {
    const recordedAnswer = str(d.recordedAnswer) || null;
    const next = (d.nextAction && typeof d.nextAction === 'object' ? d.nextAction : {}) as Record<string, unknown>;
    return {
      kind: 'already_answered',
      answer,
      recordedAnswer,
      differs: recordedAnswer !== null && !same(recordedAnswer, answer),
      followUpTaskId: next.kind === 'open_task' ? str(next.taskId) : null,
      taskId: null,
      path: null,
      message: error,
    };
  }
  return { kind: 'error', message: error ?? 'Failed to send answer', credentialRevoked: d.credentialRevoked === true };
}

/** "You answered: X", or what an earlier answer recorded. Never an error. */
export function answerOutcomeLines(o: AnswerOutcome): { headline: string; detail: string | null } {
  if (o.kind === 'sent') return { headline: `You answered: ${o.answer}`, detail: null };
  if (o.recordedAnswer === null) {
    return { headline: 'Already answered', detail: `This question had an answer already, so “${o.answer}” was not sent again.` };
  }
  if (!o.differs) return { headline: `You answered: ${o.recordedAnswer}`, detail: null };
  return {
    headline: `Already answered: ${o.recordedAnswer}`,
    detail: `That answer was recorded first, so “${o.answer}” was not sent.`,
  };
}

export async function submitAnswer(
  { workerId, taskId = null, noteId = null, message }: SubmitAnswerInput,
  fetchImpl: typeof fetch = fetch,
): Promise<AnswerOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/workers/${workerId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
  } catch {
    throw new AnswerSubmitError('The answer did not send. Check your connection.');
  }
  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  const outcome = classifyRespondReply(res.status, data, message);
  if (outcome.kind === 'error') {
    throw new AnswerSubmitError(outcome.message, { credentialRevoked: outcome.credentialRevoked, stale: staleAnswerNotice(data, taskId) });
  }
  // Only the answer that won marks the note: a duplicate's text was not recorded.
  if (outcome.kind === 'sent' && noteId && taskId) {
    await fetchImpl(`/api/tasks/${taskId}/notes/${noteId}/reply`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: message }),
    }).catch(() => {});
  }
  return outcome;
}

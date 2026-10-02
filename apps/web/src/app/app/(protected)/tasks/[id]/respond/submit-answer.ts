/**
 * Answer a waiting agent: the one path every answer surface shares (the
 * respond page, the chat feed's question card, the mission task sheet and the
 * Board's inline buttons). Posts to `/api/workers/[id]/respond` (which resumes
 * or continues the session) and marks the same ask's question note answered.
 *
 * A reply saying the question was already answered is an outcome, not an
 * error: the answer is recorded, and the surface shows what it was.
 */
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
      taskId: null;
      path: null;
      message: string | null;
    };

/** A real failure: the question is still open and the answer can be retried. */
export class AnswerSubmitError extends Error {
  readonly credentialRevoked: boolean;
  constructor(message: string, opts: { credentialRevoked?: boolean } = {}) {
    super(message);
    this.name = 'AnswerSubmitError';
    this.credentialRevoked = opts.credentialRevoked === true;
  }
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
    return {
      kind: 'already_answered',
      answer,
      recordedAnswer,
      differs: recordedAnswer !== null && !same(recordedAnswer, answer),
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
  if (outcome.kind === 'error') throw new AnswerSubmitError(outcome.message, { credentialRevoked: outcome.credentialRevoked });
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

/**
 * await_answer: the session half of ask_human (docs/specs/answered-question-resume.md).
 *
 * An interactive session (claim_task from a person's own Claude Code,
 * `workers.runner = 'mcp'`) parks its worker on a question with ask_human and
 * then waits here. `/respond`'s interactive path answers it by:
 *
 *  - appending an instruction-history entry on the worker (id = message id,
 *    deliveryState 'pending', text omitted in a sensitive workspace),
 *  - queueing an `answer` worker message with the same id in
 *    `tasks.context.pendingWorkerMessages`, and
 *  - recording `tasks.context.answerDelivery` { path: 'interactive', workerId, messageId, question }.
 *
 * The queue keeps only the newest few messages per task, so it is not where
 * the answer is read from: the delivery record and the history entry are. The
 * queue is only the fallback for the text when the history kept none.
 *
 * The answer is "unread" until its history entry is acknowledged — the same
 * ack (`workerMessagesDelivered: [id]`) receive_messages sends — so it is
 * returned once, whichever of the two reads it first.
 *
 * Pure: the route supplies the rows and the clock.
 */

import { INTERACTIVE_WORKER_RUNNER, isTerminalWorkerStatus } from '@buildd/shared';

/** The serverless ceiling, same as get_pr_review's long-poll. */
export const AWAIT_ANSWER_MAX_WAIT_SECONDS = 45;
/** Under the ceiling with room for the response round trip. */
export const AWAIT_ANSWER_DEFAULT_WAIT_SECONDS = 40;
/** One row read per interval while waiting. */
export const AWAIT_ANSWER_POLL_INTERVAL_MS = 2_000;

/** A caller's waitSeconds: default when missing or not a number, else clamped to 0-45. */
export function clampAwaitSeconds(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return AWAIT_ANSWER_DEFAULT_WAIT_SECONDS;
  return Math.min(Math.max(n, 0), AWAIT_ANSWER_MAX_WAIT_SECONDS);
}

export type NotWaitingCode = 'not_interactive' | 'session_ended' | 'no_question';

export type AnswerReadState =
  | {
      state: 'answered';
      messageId: string;
      /** Null only when neither the history nor the queue kept the text. */
      text: string | null;
      question: string | null;
      answeredAt: string | null;
    }
  | { state: 'waiting' }
  | {
      state: 'not_waiting';
      reasonCode: NotWaitingCode;
      message: string;
      continuationTaskId?: string | null;
    };

export interface AnswerWorkerRow {
  id: string;
  runner: string | null;
  status: string;
  waitingFor: unknown;
  instructionHistory: unknown;
  continuationTaskId?: string | null;
}

interface HistoryEntry { id?: string; type?: string; message?: string; deliveryState?: string }
interface QueuedMessage { id?: string; type?: string; body?: { text?: unknown; question?: unknown; workerId?: unknown } }

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function sessionEnded(worker: AnswerWorkerRow): AnswerReadState {
  const superseded = worker.status === 'superseded';
  return {
    state: 'not_waiting',
    reasonCode: 'session_ended',
    message: superseded
      ? 'The answer went to a follow-up task instead of this session (it had stopped waiting, or never read it). Stop here; the follow-up carries the work.'
      : `This worker has ended (${worker.status}); there is nothing left to wait for.`,
    ...(superseded ? { continuationTaskId: worker.continuationTaskId ?? null } : {}),
  };
}

/** Where the worker's question stands, read from what /respond recorded. */
export function readInteractiveAnswer(input: { worker: AnswerWorkerRow; taskContext: unknown }): AnswerReadState {
  const { worker } = input;
  if (worker.runner !== INTERACTIVE_WORKER_RUNNER) {
    return {
      state: 'not_waiting',
      reasonCode: 'not_interactive',
      message: `Worker ${worker.id} is managed by a runner, so await_answer does not apply: its runner resumes the session with the answer.`,
    };
  }

  // Superseded first: the answer went to a follow-up task (the session was
  // gone when it landed, or never read it), and a session that comes back
  // must not act on it alongside that task.
  if (worker.status === 'superseded') return sessionEnded(worker);

  const context = (input.taskContext && typeof input.taskContext === 'object' ? input.taskContext : {}) as Record<string, unknown>;
  const history = asArray<HistoryEntry>(worker.instructionHistory);
  const queue = asArray<QueuedMessage>(context.pendingWorkerMessages);
  const unread = (id: string) => {
    const entry = history.find(e => e?.type === 'instruction' && e.id === id);
    return entry && entry.deliveryState !== 'acknowledged' ? entry : null;
  };

  // 1. The durable record: the delivery names the message, the history entry
  //    says whether it was read.
  const delivery = context.answerDelivery as
    | { path?: string; workerId?: string; messageId?: string; question?: string; decidedAt?: string }
    | undefined;
  if (delivery?.path === 'interactive' && delivery.workerId === worker.id && delivery.messageId) {
    const entry = unread(delivery.messageId);
    if (entry) {
      const queued = queue.find(m => m?.id === delivery.messageId);
      return {
        state: 'answered',
        messageId: delivery.messageId,
        text: str(entry.message) ?? str(queued?.body?.text),
        question: str(delivery.question) ?? str(queued?.body?.question),
        answeredAt: str(delivery.decidedAt),
      };
    }
  }

  // 2. An answer still in the queue whose delivery record was lost or
  //    overwritten by a later answer on another worker.
  const queuedAnswer = queue.find(m => m?.type === 'answer' && m.body?.workerId === worker.id && m.id && unread(m.id));
  if (queuedAnswer?.id) {
    const entry = unread(queuedAnswer.id)!;
    return {
      state: 'answered',
      messageId: queuedAnswer.id,
      text: str(entry.message) ?? str(queuedAnswer.body?.text),
      question: str(queuedAnswer.body?.question),
      answeredAt: null,
    };
  }

  if (worker.status === 'waiting_input' && worker.waitingFor) return { state: 'waiting' };

  if (isTerminalWorkerStatus(worker.status)) return sessionEnded(worker);

  return {
    state: 'not_waiting',
    reasonCode: 'no_question',
    message: 'Nothing is waiting on an answer: ask with ask_human first, or the answer was already read (check receive_messages).',
  };
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read, and keep reading while the question is still open, for at most
 * waitSeconds (clamped to 45). `waitSeconds: 0` is one read. Same shape as
 * waitForPrReviewStatus: a timeout comes back as `timedOut` so the caller
 * simply calls again.
 */
export async function waitForInteractiveAnswer(params: {
  waitSeconds: number;
  read: () => Promise<AnswerReadState>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<{ result: AnswerReadState; timedOut: boolean }> {
  const sleep = params.sleep ?? realSleep;
  const now = params.now ?? Date.now;
  const budgetMs = Math.min(Math.max(params.waitSeconds, 0), AWAIT_ANSWER_MAX_WAIT_SECONDS) * 1000;
  const startedAt = now();
  for (;;) {
    const result = await params.read();
    if (result.state !== 'waiting') return { result, timedOut: false };
    if (budgetMs - (now() - startedAt) < AWAIT_ANSWER_POLL_INTERVAL_MS) return { result, timedOut: true };
    await sleep(AWAIT_ANSWER_POLL_INTERVAL_MS);
  }
}

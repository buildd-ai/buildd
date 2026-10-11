import { describe, it, expect } from 'bun:test';
import {
  AWAIT_ANSWER_DEFAULT_WAIT_SECONDS,
  AWAIT_ANSWER_MAX_WAIT_SECONDS,
  clampAwaitSeconds,
  readInteractiveAnswer,
  waitForInteractiveAnswer,
  type AnswerReadState,
} from './await-answer';

const WORKER = 'worker-1';

const parked = {
  id: WORKER,
  runner: 'mcp',
  status: 'waiting_input',
  waitingFor: { type: 'question', prompt: 'Flag or straight on?' },
  instructionHistory: [],
};

/** The state /respond's interactive path leaves behind. */
function answered(opts: { acknowledged?: boolean; queued?: boolean; sensitive?: boolean } = {}) {
  const entry: Record<string, unknown> = {
    id: 'msg-1', type: 'instruction', timestamp: 1, deliveryState: opts.acknowledged ? 'acknowledged' : 'pending',
  };
  if (!opts.sensitive) entry.message = 'Behind a flag.';
  return {
    worker: { ...parked, status: 'running', waitingFor: null, instructionHistory: [entry] },
    taskContext: {
      answerDelivery: {
        path: 'interactive', reasonCode: 'interactive_session', reason: '...', workerId: WORKER,
        decidedAt: '2026-10-11T10:00:00.000Z', messageId: 'msg-1',
        ...(opts.sensitive ? {} : { question: 'Flag or straight on?' }),
      },
      pendingWorkerMessages: opts.queued
        ? [{ id: 'msg-1', type: 'answer', body: { source: 'human', text: 'Behind a flag.', workerId: WORKER } }]
        : [],
    },
  };
}

describe('clampAwaitSeconds', () => {
  it('defaults to 40 and clamps to 0-45', () => {
    expect(AWAIT_ANSWER_DEFAULT_WAIT_SECONDS).toBe(40);
    expect(AWAIT_ANSWER_MAX_WAIT_SECONDS).toBe(45);
    expect(clampAwaitSeconds(undefined)).toBe(40);
    expect(clampAwaitSeconds(null)).toBe(40);
    expect(clampAwaitSeconds('x')).toBe(40);
    expect(clampAwaitSeconds(100)).toBe(45);
    expect(clampAwaitSeconds(-1)).toBe(0);
    expect(clampAwaitSeconds(10)).toBe(10);
    expect(clampAwaitSeconds('20')).toBe(20);
  });
});

describe('readInteractiveAnswer', () => {
  it('a parked worker with no answer is waiting', () => {
    expect(readInteractiveAnswer({ worker: parked, taskContext: {} }).state).toBe('waiting');
  });

  it('returns the answer from the durable record', () => {
    const s = readInteractiveAnswer(answered({ queued: true }));
    expect(s).toEqual({
      state: 'answered', messageId: 'msg-1', text: 'Behind a flag.', question: 'Flag or straight on?',
      answeredAt: '2026-10-11T10:00:00.000Z',
    });
  });

  // The worker-message queue keeps only the newest few per task: an answer
  // pushed out by later messages must still reach the session.
  it('returns an answer that was evicted from the message queue', () => {
    const s = readInteractiveAnswer(answered({ queued: false }));
    expect(s.state).toBe('answered');
    expect((s as any).text).toBe('Behind a flag.');
  });

  it('takes the text from the queue when the history kept none (sensitive workspace)', () => {
    const s = readInteractiveAnswer(answered({ queued: true, sensitive: true }));
    expect(s).toMatchObject({ state: 'answered', messageId: 'msg-1', text: 'Behind a flag.', question: null });
  });

  it('an answer already acknowledged is not returned again', () => {
    const s = readInteractiveAnswer(answered({ acknowledged: true }));
    expect(s.state).toBe('not_waiting');
    expect((s as any).reasonCode).toBe('no_question');
  });

  it('ignores a delivery record that belongs to another worker', () => {
    const a = answered();
    a.taskContext.answerDelivery.workerId = 'worker-other';
    expect(readInteractiveAnswer(a).state).toBe('not_waiting');
  });

  it('finds an answer still in the queue even without a delivery record', () => {
    const a = answered({ queued: true });
    delete (a.taskContext as any).answerDelivery;
    expect(readInteractiveAnswer(a)).toMatchObject({ state: 'answered', messageId: 'msg-1', text: 'Behind a flag.' });
  });

  it('a runner-managed worker is not interactive', () => {
    const s = readInteractiveAnswer({ worker: { ...parked, runner: 'runner-1' }, taskContext: {} });
    expect(s).toMatchObject({ state: 'not_waiting', reasonCode: 'not_interactive' });
  });

  it('a superseded worker (answer went cold) points at its continuation', () => {
    const s = readInteractiveAnswer({
      worker: { ...parked, status: 'superseded', waitingFor: null, continuationTaskId: 'task-2' },
      taskContext: {},
    });
    expect(s).toMatchObject({ state: 'not_waiting', reasonCode: 'session_ended', continuationTaskId: 'task-2' });
  });

  it('a failed worker (question expired) has ended', () => {
    const s = readInteractiveAnswer({ worker: { ...parked, status: 'failed' }, taskContext: {} });
    expect(s).toMatchObject({ state: 'not_waiting', reasonCode: 'session_ended' });
  });
});

describe('waitForInteractiveAnswer', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  it('waitSeconds 0 is a single read', async () => {
    let reads = 0;
    const c = clock();
    const r = await waitForInteractiveAnswer({
      waitSeconds: 0, read: async () => { reads++; return { state: 'waiting' }; }, ...c,
    });
    expect(reads).toBe(1);
    expect(r.timedOut).toBe(true);
  });

  it('returns as soon as the answer lands', async () => {
    let reads = 0;
    const c = clock();
    const r = await waitForInteractiveAnswer({
      waitSeconds: 40,
      read: async (): Promise<AnswerReadState> => (++reads < 3
        ? { state: 'waiting' }
        : { state: 'answered', messageId: 'm', text: 't', question: null, answeredAt: null }),
      ...c,
    });
    expect(reads).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.result.state).toBe('answered');
  });

  it('stops at the budget, clamped to 45 s', async () => {
    const c = clock();
    const r = await waitForInteractiveAnswer({ waitSeconds: 600, read: async () => ({ state: 'waiting' }), ...c });
    expect(r.timedOut).toBe(true);
    expect(c.now()).toBeLessThanOrEqual(45_000);
    expect(c.now()).toBeGreaterThan(40_000);
  });

  it('stops at once when nothing is waiting any more', async () => {
    let reads = 0;
    const c = clock();
    const r = await waitForInteractiveAnswer({
      waitSeconds: 40,
      read: async () => { reads++; return { state: 'not_waiting', reasonCode: 'session_ended', message: 'ended' } as AnswerReadState; },
      ...c,
    });
    expect(reads).toBe(1);
    expect(r.timedOut).toBe(false);
  });
});

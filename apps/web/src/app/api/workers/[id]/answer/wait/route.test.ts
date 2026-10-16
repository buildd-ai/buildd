import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// POST /api/workers/[id]/answer/wait is what ask_human's waitCommand calls
// from a plain shell. Its only credential is the wait capability; it answers
// status only (answered or not), never the answer text, and every call is
// the parked session's poll heartbeat.

const WORKER_ID = '11111111-1111-4111-8111-111111111111';

const mockWorkersFindFirst = mock(async () => null as any);
const mockTasksFindFirst = mock(async () => null as any);
const mockSeen = mock(async () => {});

mock.module('@/lib/interactive-worker-liveness', () => ({ recordInteractiveSessionSeen: mockSeen }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
    },
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'workers.id' },
  tasks: { id: 'tasks.id' },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

process.env.AUTH_SECRET = 'test-auth-secret-for-wait-route';

import { POST } from './route';
import { signAnswerWaitCapability, ANSWER_WAIT_CAP_HEADER } from '@/lib/answer-wait-capability';

const HOUR = 60 * 60 * 1000;
const cap = (over: Partial<{ workerId: string; askId: string; expiresAt: number }> = {}) =>
  signAnswerWaitCapability({ workerId: WORKER_ID, askId: 'ask-1', expiresAt: Date.now() + HOUR, ...over })!;

const params = (id = WORKER_ID) => ({ params: Promise.resolve({ id }) });
const req = (capability: string | null, body: unknown = { waitSeconds: 0 }) => new NextRequest(`http://localhost/api/workers/${WORKER_ID}/answer/wait`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(capability !== null ? { [ANSWER_WAIT_CAP_HEADER]: capability } : {}) },
  body: JSON.stringify(body),
});

const parked = {
  id: WORKER_ID, taskId: 'task-1', runner: 'mcp', status: 'waiting_input',
  waitingFor: { type: 'question', prompt: 'Flag or straight on?', waitCapId: 'ask-1' },
  instructionHistory: [], continuationTaskId: null,
};

describe('POST /api/workers/[id]/answer/wait', () => {
  beforeEach(() => {
    mockWorkersFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue({ context: {} });
    mockSeen.mockClear();
  });

  it('401 without a capability, with a tampered one, or one for another worker; nothing is read', async () => {
    expect((await POST(req(null), params())).status).toBe(401);
    expect((await POST(req('bldw_junk.sig'), params())).status).toBe(401);
    const other = signAnswerWaitCapability({ workerId: '22222222-2222-4222-8222-222222222222', askId: 'ask-1', expiresAt: Date.now() + HOUR })!;
    expect((await POST(req(other), params())).status).toBe(401);
    expect((await POST(req(cap({ expiresAt: Date.now() - 1 })), params())).status).toBe(401);
    expect(mockWorkersFindFirst).not.toHaveBeenCalled();
    expect(mockSeen).not.toHaveBeenCalled();
  });

  it('does not accept the capability in the query string', async () => {
    const r = new NextRequest(`http://localhost/api/workers/${WORKER_ID}/answer/wait?cap=${encodeURIComponent(cap())}`, { method: 'POST', body: '{}' });
    expect((await POST(r, params())).status).toBe(401);
  });

  it('404 for a non-UUID id or a worker that no longer exists', async () => {
    expect((await POST(req(cap()), params('nope'))).status).toBe(404);
    mockWorkersFindFirst.mockResolvedValue(null);
    expect((await POST(req(cap()), params())).status).toBe(404);
  });

  it('refuses a runner-managed worker', async () => {
    mockWorkersFindFirst.mockResolvedValue({ ...parked, runner: 'runner-1' });
    const res = await POST(req(cap()), params());
    expect(res.status).toBe(403);
    expect(mockSeen).not.toHaveBeenCalled();
  });

  it('a parked session with no answer yet times out, and records the heartbeat', async () => {
    mockWorkersFindFirst.mockResolvedValue(parked);
    const res = await POST(req(cap()), params());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ answered: false, state: 'waiting' });
    expect(typeof data.retryAfter).toBe('number');
    expect(mockSeen).toHaveBeenCalledWith(WORKER_ID);
  });

  it('answered: says so, and never carries the answer or the question', async () => {
    mockWorkersFindFirst.mockResolvedValue({
      ...parked, status: 'running', waitingFor: null,
      instructionHistory: [{ id: 'msg-1', type: 'instruction', message: 'Behind a flag.', deliveryState: 'pending' }],
    });
    mockTasksFindFirst.mockResolvedValue({
      context: { answerDelivery: { path: 'interactive', workerId: WORKER_ID, messageId: 'msg-1', waitCapId: 'ask-1', question: 'Flag or straight on?' } },
    });
    const res = await POST(req(cap()), params());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ answered: true, state: 'answered' });
    expect(text).not.toContain('Behind a flag');
    expect(text).not.toContain('Flag or straight on');
    expect(text).not.toContain('msg-1');
  });

  it('401 superseded once a newer ask replaced its question', async () => {
    mockWorkersFindFirst.mockResolvedValue({ ...parked, waitingFor: { ...parked.waitingFor, waitCapId: 'ask-2' } });
    const res = await POST(req(cap()), params());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'superseded' });
    expect(mockSeen).not.toHaveBeenCalled();
  });

  it('ended: the worker is gone, with its status as the reason', async () => {
    mockWorkersFindFirst.mockResolvedValue({ ...parked, status: 'failed' });
    const data = await (await POST(req(cap()), params())).json();
    expect(data).toEqual({ answered: false, state: 'ended', reason: 'failed' });
  });
});

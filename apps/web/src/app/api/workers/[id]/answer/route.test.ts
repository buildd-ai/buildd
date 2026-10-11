import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// POST /api/workers/[id]/answer backs the await_answer MCP action: an
// interactive session long-polls here for the answer to its own ask_human
// question. Every call is also the session's poll heartbeat.

const WORKER_ID = '11111111-1111-4111-8111-111111111111';

const mockAuth = mock(async () => ({ id: 'account-1', level: 'worker' }) as any);
const mockOwns = mock(() => true);
const mockWorkersFindFirst = mock(async () => null as any);
const mockTasksFindFirst = mock(async () => null as any);
const mockSeen = mock(async () => {});

mock.module('@/lib/task-token-auth', () => ({ authenticateTaskScopedCaller: mockAuth }));
mock.module('@/lib/worker-owner', () => ({ callerOwnsWorker: mockOwns }));
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

import { POST } from './route';

const params = (id = WORKER_ID) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown = { waitSeconds: 0 }) => new NextRequest(`http://localhost/api/workers/${WORKER_ID}/answer`, {
  method: 'POST',
  headers: { authorization: 'Bearer bld_test', 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const parked = {
  id: WORKER_ID, accountId: 'account-1', claimedByUserId: null, taskId: 'task-1',
  runner: 'mcp', status: 'waiting_input',
  waitingFor: { type: 'question', prompt: 'Flag or straight on?' },
  instructionHistory: [], continuationTaskId: null,
};

describe('POST /api/workers/[id]/answer', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({ id: 'account-1', level: 'worker' });
    mockOwns.mockReset();
    mockOwns.mockReturnValue(true);
    mockWorkersFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue({ context: {} });
    mockSeen.mockClear();
  });

  it('401 without a caller', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(req(), params())).status).toBe(401);
  });

  it('404 for a non-UUID id or a worker the caller does not own', async () => {
    expect((await POST(req(), params('nope'))).status).toBe(404);
    mockWorkersFindFirst.mockResolvedValue(parked);
    mockOwns.mockReturnValue(false);
    expect((await POST(req(), params())).status).toBe(404);
    expect(mockSeen).not.toHaveBeenCalled();
  });

  it('a parked session with no answer yet times out, and records the heartbeat', async () => {
    mockWorkersFindFirst.mockResolvedValue(parked);
    const res = await POST(req({ waitSeconds: 0 }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'waiting', timedOut: true, workerId: WORKER_ID });
    expect(mockSeen).toHaveBeenCalledWith(WORKER_ID);
  });

  it('returns an answer from the durable record even when the queue lost it', async () => {
    mockWorkersFindFirst.mockResolvedValue({
      ...parked, status: 'running', waitingFor: null,
      instructionHistory: [{ id: 'msg-1', type: 'instruction', message: 'Behind a flag.', timestamp: 1, deliveryState: 'pending' }],
    });
    mockTasksFindFirst.mockResolvedValue({
      context: {
        answerDelivery: { path: 'interactive', reasonCode: 'interactive_session', workerId: WORKER_ID, messageId: 'msg-1', question: 'Flag or straight on?', decidedAt: '2026-10-11T10:00:00.000Z' },
        pendingWorkerMessages: [],
      },
    });
    const data = await (await POST(req({ waitSeconds: 40 }), params())).json();
    expect(data).toMatchObject({ state: 'answered', messageId: 'msg-1', text: 'Behind a flag.', question: 'Flag or straight on?', timedOut: false });
  });

  it('defaults a missing or malformed body to the default wait without failing', async () => {
    mockWorkersFindFirst.mockResolvedValue({ ...parked, status: 'failed' });
    const bad = new NextRequest(`http://localhost/api/workers/${WORKER_ID}/answer`, { method: 'POST', headers: { authorization: 'Bearer bld_test' }, body: 'not json' });
    const data = await (await POST(bad, params())).json();
    expect(data).toMatchObject({ state: 'not_waiting', reasonCode: 'session_ended' });
  });

  it('a runner-managed worker is not interactive', async () => {
    mockWorkersFindFirst.mockResolvedValue({ ...parked, runner: 'runner-1' });
    const data = await (await POST(req(), params())).json();
    expect(data).toMatchObject({ state: 'not_waiting', reasonCode: 'not_interactive' });
    expect(mockSeen).not.toHaveBeenCalled();
  });
});

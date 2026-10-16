import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// POST /api/workers/[id]/answer/capability: ask_human's second call. The
// owner of a parked interactive worker gets a wait capability (and the shell
// command that uses it) for the question that is open right now. Minting
// stamps a fresh ask id on the live question, so an older capability stops
// working; the capability expires with the park.

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const HOUR = 60 * 60 * 1000;

const mockAuth = mock(async () => ({ id: 'account-1', level: 'worker' }) as any);
const mockOwns = mock(() => true);
const mockWorkersFindFirst = mock(async () => null as any);
const mockTasksFindFirst = mock(async () => null as any);
const updateSets: any[] = [];
const mockReturning = mock(async () => [] as any[]);

mock.module('@/lib/task-token-auth', () => ({ authenticateTaskScopedCaller: mockAuth }));
mock.module('@/lib/worker-owner', () => ({ callerOwnsWorker: mockOwns, claimingUserId: () => null }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
    },
    update: () => ({
      set: (s: any) => {
        updateSets.push(s);
        return { where: () => ({ returning: mockReturning }) };
      },
    }),
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'workers.id', runner: 'workers.runner', status: 'workers.status', waitingFor: 'workers.waitingFor', updatedAt: 'workers.updatedAt', taskId: 'workers.taskId' },
  tasks: { id: 'tasks.id' },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ type: 'and', conditions }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: any[]) => ({ type: 'sql', strings: [...strings], values }), { raw: (s: string) => s }),
}));

process.env.AUTH_SECRET = 'test-auth-secret-for-capability-route';
process.env.NEXT_PUBLIC_APP_URL = 'https://buildd.example';

import { POST } from './route';
import { verifyAnswerWaitCapability } from '@/lib/answer-wait-capability';

const params = (id = WORKER_ID) => ({ params: Promise.resolve({ id }) });
const req = () => new NextRequest(`http://localhost/api/workers/${WORKER_ID}/answer/capability`, {
  method: 'POST',
  headers: { authorization: 'Bearer bld_test' },
});

const parked = {
  id: WORKER_ID, accountId: 'account-1', claimedByUserId: null, taskId: 'task-1',
  runner: 'mcp', status: 'waiting_input', waitingFor: { type: 'question', prompt: 'Q?' },
};

describe('POST /api/workers/[id]/answer/capability', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({ id: 'account-1', level: 'worker' });
    mockOwns.mockReset();
    mockOwns.mockReturnValue(true);
    mockWorkersFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue({ missionId: null });
    mockReturning.mockReset();
    updateSets.length = 0;
  });

  // A signed-in (OAuth) session owns a worker only with the worker's
  // workspaceId and claimedByUserId in hand (lib/worker-owner.ts). Without
  // them every session's own worker reads as not found.
  it('loads the worker fields ownership needs', async () => {
    mockWorkersFindFirst.mockResolvedValue(parked);
    mockReturning.mockResolvedValue([]);
    await POST(req(), params());
    const cols = (mockWorkersFindFirst.mock.calls[0] as any[])[0].columns;
    expect(cols.workspaceId).toBe(true);
    expect(cols.claimedByUserId).toBe(true);
  });

  it('401 without a caller; 404 for a non-UUID or a worker the caller does not own', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(req(), params())).status).toBe(401);
    mockAuth.mockResolvedValue({ id: 'account-1', level: 'worker' });
    expect((await POST(req(), params('nope'))).status).toBe(404);
    mockWorkersFindFirst.mockResolvedValue(parked);
    mockOwns.mockReturnValue(false);
    expect((await POST(req(), params())).status).toBe(404);
    expect(updateSets).toHaveLength(0);
  });

  it('refuses a runner-managed worker and a worker with no open question', async () => {
    mockWorkersFindFirst.mockResolvedValue({ ...parked, runner: 'runner-1' });
    expect((await POST(req(), params())).status).toBe(403);
    mockWorkersFindFirst.mockResolvedValue({ ...parked, status: 'running', waitingFor: null });
    expect((await POST(req(), params())).status).toBe(409);
    expect(updateSets).toHaveLength(0);
  });

  it('409 when the question closed between the read and the stamp', async () => {
    mockWorkersFindFirst.mockResolvedValue(parked);
    mockReturning.mockResolvedValue([]);
    expect((await POST(req(), params())).status).toBe(409);
  });

  it('mints a capability bound to this worker and a fresh ask id, expiring with the park', async () => {
    const parkedAt = new Date(Date.now() - 10 * 60 * 1000);
    mockWorkersFindFirst.mockResolvedValue(parked);
    mockReturning.mockResolvedValue([{ updatedAt: parkedAt, taskId: 'task-1' }]);
    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    const data = await res.json();

    // The stamp: only waitingFor, never updated_at (the park clock).
    expect(updateSets).toHaveLength(1);
    expect(Object.keys(updateSets[0])).toEqual(['waitingFor']);
    const askId = updateSets[0].waitingFor.values.find((v: unknown) => typeof v === 'string' && !v.startsWith('workers.'));
    expect(typeof askId).toBe('string');

    const verified = verifyAnswerWaitCapability(data.capability, WORKER_ID);
    expect(verified).toMatchObject({ ok: true, workerId: WORKER_ID, askId });
    expect(data.expiresAt).toBe(new Date(parkedAt.getTime() + 24 * HOUR).toISOString());
    expect((verified as { expiresAt: number }).expiresAt).toBe(parkedAt.getTime() + 24 * HOUR);
    expect(data.waitUrl).toBe(`https://buildd.example/api/workers/${WORKER_ID}/answer/wait`);
    expect(data.waitCommand).toContain(data.capability);
    expect(data.waitCommand).toContain(data.waitUrl);
    expect(data.waitCommand).not.toContain('bld_test');
  });

  it('a mission task expires with the shorter mission park', async () => {
    const parkedAt = new Date(Date.now() - 60 * 1000);
    mockWorkersFindFirst.mockResolvedValue(parked);
    mockTasksFindFirst.mockResolvedValue({ missionId: 'mission-1' });
    mockReturning.mockResolvedValue([{ updatedAt: parkedAt, taskId: 'task-1' }]);
    const data = await (await POST(req(), params())).json();
    expect(data.expiresAt).toBe(new Date(parkedAt.getTime() + 4 * HOUR).toISOString());
  });

  it('503 when the server has no signing secret, before stamping anything', async () => {
    const saved = { a: process.env.AUTH_SECRET, n: process.env.NEXTAUTH_SECRET, e: process.env.ENCRYPTION_KEY };
    delete process.env.AUTH_SECRET; delete process.env.NEXTAUTH_SECRET; delete process.env.ENCRYPTION_KEY;
    try {
      mockWorkersFindFirst.mockResolvedValue(parked);
      expect((await POST(req(), params())).status).toBe(503);
      expect(updateSets).toHaveLength(0);
    } finally {
      process.env.AUTH_SECRET = saved.a;
      if (saved.n !== undefined) process.env.NEXTAUTH_SECRET = saved.n;
      if (saved.e !== undefined) process.env.ENCRYPTION_KEY = saved.e;
    }
  });
});

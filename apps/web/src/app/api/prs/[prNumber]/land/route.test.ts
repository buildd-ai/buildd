import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => ({ id: 'u1' }) as any);
const mockResolve = mock(() => ({ workspaceId: 'ws1', taskId: 'task1' }) as any);
const mockSupersede = mock(() => Promise.resolve());
const current = { state: 'CHANGES_REQUESTED', version: 9, head: 'h1', round: 2, stateReason: null };
const mockLand = mock(async (_p: any, _c: any): Promise<any> => ({ result: { result: 'applied' }, current, attempt: { taskId: 'fix1' } }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/pr-resolve', () => ({ resolveOpenWorkerForUser: mockResolve }));
mock.module('@/lib/escalation-supersession', () => ({ supersedeAncestorEscalations: mockSupersede }));
mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@/lib/workflow/kernel-client', () => ({
  landEscalatedThroughKernel: mockLand,
  isDoorError: () => false,
  doorErrorResponse: () => new Response('door', { status: 503 }),
}));

import { POST } from './route';

const call = (body: unknown) =>
  POST(new NextRequest('http://x/api/prs/12/land', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ prNumber: '12' }) });

describe('POST /api/prs/[n]/land', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockImplementation(() => ({ id: 'u1' }) as any);
    mockLand.mockClear(); mockSupersede.mockClear();
    mockLand.mockImplementation(async () => ({ result: { result: 'applied' }, current, attempt: { taskId: 'fix1' } }));
  });

  it('401 without a session', async () => {
    mockGetCurrentUser.mockImplementation(() => null as any);
    expect((await call({ headSha: 'h1' })).status).toBe(401);
  });

  it('400 without the head the person decided on', async () => {
    const res = await call({});
    expect(res.status).toBe(400);
    expect(mockLand).not.toHaveBeenCalled();
  });

  it('files one landing task as the signed-in person, bound to the card head and version', async () => {
    const res = await call({ headSha: 'h1', version: 7 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, dispatched: true, taskId: 'fix1' });
    expect(mockLand.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws1', prNumber: 12, actor: 'human:u1', expectedVersion: 7, decisionHeadSha: 'h1' });
    expect(mockSupersede).toHaveBeenCalledTimes(1);
  });

  it('a stale head is a 409 in plain words and the escalation note stays', async () => {
    mockLand.mockImplementation(async () => ({ result: { result: 'rejected', reason: 'decision_head_stale' }, current, attempt: null }));
    const res = await call({ headSha: 'old' });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.stale).toBe(true);
    expect(j.error).toContain('The landing task was not filed');
    expect(mockSupersede).not.toHaveBeenCalled();
  });

  it('a replay after the PR escalated again does not clear the new escalation', async () => {
    mockLand.mockImplementation(async () => ({ result: { result: 'duplicate' }, current: { ...current, state: 'ESCALATED' }, attempt: null }));
    const res = await call({ headSha: 'h1' });
    expect(res.status).toBe(409);
    expect(mockSupersede).not.toHaveBeenCalled();
  });

  it('a PR the kernel does not own is refused', async () => {
    mockLand.mockImplementation(async () => null);
    expect((await call({ headSha: 'h1' })).status).toBe(409);
  });
});

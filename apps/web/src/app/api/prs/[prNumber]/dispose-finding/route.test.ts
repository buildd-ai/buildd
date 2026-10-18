import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TASK = '00000000-0000-4000-8000-0000000000aa';
const mockGetCurrentUser = mock(() => null as any);
const mockResolve = mock(() => ({ workspaceId: 'ws-1' }) as any);
const mockTaskFind = mock(() => Promise.resolve({ id: TASK }) as any);
const mockDispose = mock(async (_p: any, _c: any): Promise<any> => ({ handled: true, result: { result: 'applied' } }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/pr-resolve', () => ({ resolveOpenWorkerForUser: mockResolve }));
mock.module('@/lib/workflow/github-facts', () => ({ workspaceRepo: async () => ({ repoFullName: 'acme/w', installationId: 1 }) }));
mock.module('@/lib/workflow/kernel-client', () => ({
  disposeFinding: mockDispose,
  isDoorError: () => false,
  doorErrorResponse: () => new Response(null, { status: 503 }),
}));
mock.module('@buildd/core/db', () => ({ db: { query: { tasks: { findFirst: mockTaskFind } } } }));

import { POST } from './route';

const call = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://x/api/prs/7/dispose-finding', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ prNumber: '7' }) });

beforeEach(() => {
  mockGetCurrentUser.mockReset().mockReturnValue({ id: 'user-1' });
  mockDispose.mockClear();
});

describe('POST /api/prs/[prNumber]/dispose-finding', () => {
  it('an API key or agent has no session, so it is refused before the kernel is asked', async () => {
    mockGetCurrentUser.mockReturnValue(null);
    expect((await call({ findingId: 'r1:0', disposition: 'waived', reason: 'ok' })).status).toBe(401);
    expect(mockDispose).not.toHaveBeenCalled();
  });

  it('a reason is required', async () => {
    expect((await call({ findingId: 'r1:0', disposition: 'waived', reason: '  ' })).status).toBe(400);
    expect(mockDispose).not.toHaveBeenCalled();
  });

  it('a deferral needs a full task id, not a short one', async () => {
    const res = await call({ findingId: 'r1:0', disposition: 'deferred', reason: 'later', deferredToTaskId: '8237cfa9' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('deferral_needs_task');
    expect(mockDispose).not.toHaveBeenCalled();
  });

  it('a waiver submits exactly one finding as the signed-in person, with the reason', async () => {
    const res = await call({ findingId: 'r1:0', disposition: 'waived', reason: 'covered by the e2e suite' });
    expect(res.status).toBe(200);
    expect(mockDispose).toHaveBeenCalledTimes(1);
    const [input, c] = mockDispose.mock.calls[0];
    expect(input).toMatchObject({ workspaceId: 'ws-1', prNumber: 7, actor: 'human:user-1', findingId: 'r1:0', disposition: 'waived', reason: 'covered by the e2e suite', deferredToTaskId: null });
    expect(c.principal).toEqual({ kind: 'user', id: 'user-1' });
  });

  it('a deferral to a full task id passes it on; a kernel refusal is a 409 with its code', async () => {
    expect((await call({ findingId: 'r1:0', disposition: 'deferred', reason: 'later', deferredToTaskId: TASK })).status).toBe(200);
    expect(mockDispose.mock.calls[0][0].deferredToTaskId).toBe(TASK);
    mockDispose.mockResolvedValueOnce({ handled: true, result: { result: 'rejected', reason: 'finding_closed' } });
    const res = await call({ findingId: 'r1:0', disposition: 'waived', reason: 'x' });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe('finding_closed');
    expect(j.error).toStartWith('Finding not closed: ');
    expect(j.error).not.toContain('finding_closed');
  });

  it('the head and version the card showed are passed on as the decision', async () => {
    await call({ findingId: 'r1:0', disposition: 'waived', reason: 'x', headSha: 'abc123', version: 4 });
    expect(mockDispose.mock.calls[0][0].decision).toEqual({ headSha: 'abc123', version: 4 });
  });

  it('a duplicate is success only while the finding is closed the way asked; a restated one is refused', async () => {
    mockDispose.mockResolvedValueOnce({ handled: true, result: { result: 'duplicate', reason: 'idempotency_key_seen' }, findingStatus: 'waived' });
    expect((await call({ findingId: 'r1:0', disposition: 'waived', reason: 'x' })).status).toBe(200);
    mockDispose.mockResolvedValueOnce({ handled: true, result: { result: 'duplicate', reason: 'idempotency_key_seen' }, findingStatus: 'open' });
    const res = await call({ findingId: 'r1:0', disposition: 'waived', reason: 'x' });
    expect(res.status).toBe(409);
    expect((await res.json()).stale).toBe(true);
  });
});

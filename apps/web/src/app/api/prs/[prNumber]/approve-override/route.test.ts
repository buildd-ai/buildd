import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TASK = '00000000-0000-4000-8000-0000000000aa';
const mockGetCurrentUser = mock(() => null as any);
const mockAuth = mock(async (_t: any, _r: any) => null as any);
const mockResolve = mock(async (..._a: any[]) => ({ workspaceId: 'ws-1', taskId: TASK }) as any);
const mockPerm = mock(async (..._a: any[]) => ({ overridePermitted: true, hasMergePermission: true, refusal: null }) as any);
const mockApprove = mock(async (_p: any, _c: any): Promise<any> => ({ result: { result: 'applied' }, current: { state: 'APPROVED' } }));
const mockSupersede = mock(async (..._a: any[]) => {});

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/task-token-auth', () => ({ authenticateTaskScopedCaller: mockAuth }));
mock.module('@/lib/pr-resolve', () => ({ resolveOpenWorkerForUser: mockResolve }));
mock.module('@/lib/override-permission', () => ({
  reviewOverridePermission: mockPerm,
  reviewOverrideRefusalSentence: (r: string) => `Refused because ${r.replace(/_/g, ' ')}.`,
}));
mock.module('@/lib/escalation-supersession', () => ({ supersedeAncestorEscalations: mockSupersede }));
mock.module('@/lib/workflow/kernel-client', () => ({
  approveOverride: mockApprove,
  isDoorError: () => false,
  doorErrorResponse: () => new Response(null, { status: 503 }),
}));
mock.module('@buildd/core/db', () => ({ db: {} }));

import { POST } from './route';

const call = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  POST(new NextRequest('http://x/api/prs/7/approve-override', { method: 'POST', body: JSON.stringify(body), headers }), { params: Promise.resolve({ prNumber: '7' }) });
const DECISION = { headSha: 'abc123', version: 4 };

beforeEach(() => {
  mockGetCurrentUser.mockReset().mockReturnValue({ id: 'user-1' });
  mockAuth.mockReset().mockResolvedValue(null);
  mockPerm.mockReset().mockResolvedValue({ overridePermitted: true, hasMergePermission: true, refusal: null });
  mockApprove.mockReset().mockResolvedValue({ result: { result: 'applied' }, current: { state: 'APPROVED' } });
  mockSupersede.mockClear();
});

describe('POST /api/prs/[prNumber]/approve-override', () => {
  it('no person, no override: unauthenticated is a 401 and the kernel is never asked', async () => {
    mockGetCurrentUser.mockReturnValue(null);
    expect((await call(DECISION)).status).toBe(401);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('an API key or a per-task token is refused in plain words, before any permission is read', async () => {
    for (const account of [{ id: 'a1', teamId: 't1' }, { id: 'a1', teamId: 't1', taskScope: { workspaceId: 'ws-1' }, sessionUserId: 'user-1' }]) {
      mockAuth.mockResolvedValueOnce(account);
      const res = await call(DECISION, { authorization: 'Bearer bld_x' });
      expect(res.status).toBe(403);
      const j = await res.json();
      expect(j.code).toBe('human_required');
      expect(j.error).toStartWith('The approval was not recorded: ');
    }
    expect(mockPerm).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('a person\'s own OAuth session acts as that person', async () => {
    mockAuth.mockResolvedValueOnce({ id: 'a1', teamId: 't1', sessionUserId: 'user-9' });
    expect((await call(DECISION, { authorization: 'Bearer oauth' })).status).toBe(200);
    expect(mockResolve.mock.calls.at(-1)![0]).toBe('user-9');
    expect(mockApprove.mock.calls[0][0].actor).toBe('human:user-9');
    expect(mockApprove.mock.calls[0][1].principal).toEqual({ kind: 'user', id: 'user-9' });
  });

  it('the decision head is required; the version is passed on only when sent', async () => {
    const res = await call({ version: 4 });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('commit_id_required');
    expect(mockApprove).not.toHaveBeenCalled();
    await call({ headSha: 'abc123' });
    expect(mockApprove.mock.calls[0][0].decision).toEqual({ headSha: 'abc123' });
  });

  it('an authorized override is one command bound to the head and version, with the permission read fresh; the note clears', async () => {
    const res = await call({ ...DECISION, reason: 'accepted as is' });
    expect(res.status).toBe(200);
    expect(mockPerm.mock.calls[0]).toEqual(['user-1', 'ws-1', { fresh: true }]);
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockApprove.mock.calls[0][0]).toEqual({
      workspaceId: 'ws-1', prNumber: 7, actor: 'human:user-1', decision: DECISION, reason: 'accepted as is',
      hasMergePermission: true, overridePermitted: true,
    });
    expect(mockSupersede).toHaveBeenCalledTimes(1);
  });

  it('a person without permission is refused with the sentence; nothing is submitted and the note stays', async () => {
    mockPerm.mockResolvedValueOnce({ overridePermitted: false, hasMergePermission: false, refusal: 'role' });
    const res = await call(DECISION);
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe('role');
    expect(j.error).toContain('Refused because role.');
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockSupersede).not.toHaveBeenCalled();
  });

  it('a stale head is a 409 in plain words; the note stays', async () => {
    mockApprove.mockResolvedValueOnce({ result: { result: 'rejected', reason: 'decision_head_stale' }, current: { state: 'ESCALATED' } });
    const res = await call(DECISION);
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j).toMatchObject({ code: 'decision_head_stale', stale: true });
    expect(j.error).not.toContain('decision_head_stale');
    expect(mockSupersede).not.toHaveBeenCalled();
  });

  it('a replay is success only once the PR no longer waits on a person', async () => {
    mockApprove.mockResolvedValueOnce({ result: { result: 'duplicate', reason: 'idempotency_key_seen' }, current: { state: 'LANDING' } });
    expect((await call(DECISION)).status).toBe(200);
    mockApprove.mockResolvedValueOnce({ result: { result: 'duplicate', reason: 'idempotency_key_seen' }, current: { state: 'ESCALATED' } });
    const res = await call(DECISION);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('decision_already_answered');
  });

  it('a PR the kernel does not run is a 409, never a legacy approval', async () => {
    mockApprove.mockResolvedValueOnce(null);
    const res = await call(DECISION);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('legacy_owns');
  });
});

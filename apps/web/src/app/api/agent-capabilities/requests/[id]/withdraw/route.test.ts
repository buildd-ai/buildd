import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuth = mock((_key: string | null) => Promise.resolve(null as any));
const mockResolvePrincipal = mock((_a: any, _i: any) => Promise.resolve(null as any));
const mockAudit = mock((_row: any) => Promise.resolve());
const mockWithdraw = mock((_p: any, _id: string) => Promise.resolve(null as any));

mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: mockAuth,
  taskScopeAllowsWorker: (a: any, w: any) => !a.taskScope || w.taskId === a.taskScope.taskId,
  taskScopeAllowsWorkspace: (a: any, ws: any) => !a.taskScope || ws === a.taskScope.workspaceId,
}));
mock.module('@/lib/agent-capabilities/worker-principal', () => ({ resolveWorkerPrincipal: mockResolvePrincipal }));
mock.module('@/lib/agent-capabilities/audit', () => ({ recordCapabilityDecision: mockAudit }));
mock.module('@/lib/capability-hold-store', () => ({ withdrawCapabilityRequest: mockWithdraw }));

import { POST } from './route';

const TASK = '22222222-2222-4222-8222-222222222222';
const WS = '33333333-3333-4333-8333-333333333333';
const WORKER = '11111111-1111-4111-8111-111111111111';
const R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT = { id: 'acct-1', teamId: 'team-1', level: 'worker' };
const TASK_TOKEN = { ...ACCOUNT, taskScope: { taskId: TASK, workspaceId: WS, expiresAt: Date.now() + 60_000 } };
const PRINCIPAL = { kind: 'agent_run', via: 'runner_key', workerId: WORKER, taskId: TASK, workspaceId: WS, teamId: 'team-1', accountId: 'acct-1' };

function post(body: unknown, key: string | null = 'bldt_x', id = R1) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  return [new NextRequest(`http://localhost/api/agent-capabilities/requests/${id}/withdraw`, { method: 'POST', headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }] as const;
}

beforeEach(() => {
  mockAuth.mockReset(); mockResolvePrincipal.mockReset(); mockAudit.mockClear(); mockWithdraw.mockReset();
  mockAuth.mockResolvedValue(TASK_TOKEN);
  mockResolvePrincipal.mockResolvedValue({ ok: true, principal: PRINCIPAL, workspace: { id: WS } });
  mockWithdraw.mockResolvedValue({ ok: true, requestId: R1, alreadyClosed: false, status: 'expired' });
});

describe('POST /api/agent-capabilities/requests/[id]/withdraw', () => {
  it('the worker withdraws its own request under a task token, and is told to declare what it lacks', async () => {
    const res = await POST(...post({ workerId: WORKER }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ requestId: R1, status: 'expired', alreadyClosed: false });
    expect(json.nextSteps[0]).toContain('proceededWithout');
    expect(mockWithdraw.mock.calls[0][0]).toMatchObject({ workerId: WORKER, via: 'task_token' });
    expect(mockWithdraw.mock.calls[0][1]).toBe(R1);
  });

  it("a task token cannot withdraw under another task's worker", async () => {
    mockResolvePrincipal.mockResolvedValue({ ok: true, principal: { ...PRINCIPAL, taskId: '99999999-9999-4999-8999-999999999999' }, workspace: { id: WS } });
    expect((await POST(...post({ workerId: WORKER }))).status).toBe(404);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('passes the store\'s refusals through: a granted or decided request, or not this worker\'s', async () => {
    mockWithdraw.mockResolvedValue({ ok: false, status: 409, code: 'already_granted', error: 'granted', requestStatus: 'granted' });
    const res = await POST(...post({ workerId: WORKER }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'already_granted', requestStatus: 'granted' });
    mockWithdraw.mockResolvedValue({ ok: false, status: 404, code: 'not_found', error: 'nope' });
    expect((await POST(...post({ workerId: WORKER }))).status).toBe(404);
  });

  it('401 without a key, 403 for a trigger token, 404 for a non-UUID id, 400 without workerId', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(...post({ workerId: WORKER }, null))).status).toBe(401);
    mockAuth.mockResolvedValue({ ...ACCOUNT, level: 'trigger' });
    expect((await POST(...post({ workerId: WORKER }))).status).toBe(403);
    mockAuth.mockResolvedValue(TASK_TOKEN);
    expect((await POST(...post({ workerId: WORKER }, 'bldt_x', 'not-a-uuid'))).status).toBe(404);
    expect((await POST(...post({}))).status).toBe(400);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });
});

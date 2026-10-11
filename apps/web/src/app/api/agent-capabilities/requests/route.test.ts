import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mocks (before importing the route) ────────────────────────────────────────

const mockAuth = mock((_key: string | null) => Promise.resolve(null as any));
const mockResolvePrincipal = mock((_a: any, _i: any) => Promise.resolve(null as any));
const mockAudit = mock((_row: any) => Promise.resolve());
const mockRequest = mock((_p: any, _r: any) => Promise.resolve(null as any));
const mockList = mock((_t: string, _o: any) => Promise.resolve([] as any[]));
const mockUser = mock(() => Promise.resolve(null as any));

mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: mockAuth,
  taskScopeAllowsWorker: (a: any, w: any) => !a.taskScope || w.taskId === a.taskScope.taskId,
  taskScopeAllowsWorkspace: (a: any, ws: any) => !a.taskScope || ws === a.taskScope.workspaceId,
}));
mock.module('@/lib/agent-capabilities/worker-principal', () => ({ resolveWorkerPrincipal: mockResolvePrincipal }));
mock.module('@/lib/agent-capabilities/audit', () => ({ recordCapabilityDecision: mockAudit }));
mock.module('@/lib/capability-grants-store', () => ({ requestCapability: mockRequest, listTeamRequests: mockList }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: async () => ['77777777-7777-4777-8777-777777777777'] }));
mock.module('@/lib/permissions', () => ({ can: async () => false }));

import { GET, POST } from './route';

// ── fixtures (illustrative) ───────────────────────────────────────────────────

const TASK = '22222222-2222-4222-8222-222222222222';
const WS = '33333333-3333-4333-8333-333333333333';
const WORKER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = { id: 'acct-1', teamId: 'team-1', level: 'worker' };
const TASK_TOKEN = { ...ACCOUNT, taskScope: { taskId: TASK, workspaceId: WS, expiresAt: Date.now() + 60_000 } };
const PRINCIPAL = { kind: 'agent_run', via: 'runner_key', workerId: WORKER, taskId: TASK, workspaceId: WS, teamId: 'team-1', accountId: 'acct-1' };

function post(body: unknown, key: string | null = 'bldt_x') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  return new NextRequest('http://localhost/api/agent-capabilities/requests', { method: 'POST', headers, body: JSON.stringify(body) });
}

beforeEach(() => {
  mockAuth.mockReset(); mockResolvePrincipal.mockReset(); mockAudit.mockClear(); mockRequest.mockReset(); mockList.mockReset(); mockUser.mockReset();
  mockAuth.mockResolvedValue(TASK_TOKEN);
  mockList.mockResolvedValue([]);
  mockResolvePrincipal.mockResolvedValue({ ok: true, principal: PRINCIPAL, workspace: { id: WS } });
  mockRequest.mockResolvedValue({
    ok: true, deduped: false, grant: { id: 'g1', status: 'pending' },
    resolution: { kind: 'pending_approval', reasonCode: 'policy_ask_human', target: { provider: 'axiom', connectorId: 'c', connectorName: 'Axiom' }, policy: null, ttlSeconds: 3600, grantId: 'g1', nextSteps: [], alternatives: [] },
  });
});

describe('POST /api/agent-capabilities/requests', () => {
  it('asks semantically under a task token, as its own worker', async () => {
    const res = await POST(post({ workerId: WORKER, capability: 'observability:query', provider: 'axiom', reason: 'trace latency' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({ outcome: 'pending_approval', provider: 'axiom', connector: 'Axiom', grant: { id: 'g1' } });
    expect(mockRequest.mock.calls[0][0]).toMatchObject({ workerId: WORKER, via: 'task_token' });
    expect(mockRequest.mock.calls[0][1]).toMatchObject({ capability: 'observability:query', provider: 'axiom', risk: 'query' });
  });

  it('refuses a connector id or credential in the ask', async () => {
    const res = await POST(post({ workerId: WORKER, capability: 'observability:query', connectorId: 'abc' }));
    expect(res.status).toBe(400);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("a task token cannot ask for another task's worker (replay / cross-task)", async () => {
    mockResolvePrincipal.mockResolvedValue({ ok: true, principal: { ...PRINCIPAL, taskId: '99999999-9999-4999-8999-999999999999' }, workspace: { id: WS } });
    const res = await POST(post({ workerId: WORKER, capability: 'observability:query' }));
    expect(res.status).toBe(404);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockAudit.mock.calls.at(-1)![0]).toMatchObject({ capability: 'capability.request', decision: 'refused', reasonCode: 'task_scope_mismatch' });
  });

  it('a dead worker or another team’s worker is refused before any lookup', async () => {
    mockResolvePrincipal.mockResolvedValue({ ok: false, status: 404, error: 'Worker not found', reasonCode: 'not_found' });
    expect((await POST(post({ workerId: WORKER, capability: 'observability:query' }))).status).toBe(404);
    mockResolvePrincipal.mockResolvedValue({ ok: false, status: 409, error: 'Worker is not live', reasonCode: 'worker_not_live' });
    expect((await POST(post({ workerId: WORKER, capability: 'observability:query' }))).status).toBe(409);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('401 without a key; 403 for a trigger token', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(post({ workerId: WORKER, capability: 'observability:query' }, null))).status).toBe(401);
    mockAuth.mockResolvedValue({ ...ACCOUNT, level: 'trigger' });
    expect((await POST(post({ workerId: WORKER, capability: 'observability:query' }))).status).toBe(403);
  });

  it('a repeat ask that returns the same row is 200, deduped', async () => {
    mockRequest.mockResolvedValue({
      ok: true, deduped: true, grant: { id: 'g1', status: 'pending' },
      resolution: { kind: 'pending_approval', reasonCode: 'already_pending', target: null, policy: null, ttlSeconds: 3600, grantId: 'g1', nextSteps: [], alternatives: [] },
    });
    const res = await POST(post({ workerId: WORKER, capability: 'observability:query' }));
    expect(res.status).toBe(200);
    expect((await res.json()).deduped).toBe(true);
  });
});

describe('GET /api/agent-capabilities/requests', () => {
  it('agent keys cannot list', async () => {
    const res = await GET(new NextRequest('http://localhost/api/agent-capabilities/requests', { headers: { authorization: 'Bearer bldt_x' } }));
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('a signed-in member lists their team, told whether they may decide', async () => {
    mockUser.mockResolvedValue({ id: 'user-1' });
    const res = await GET(new NextRequest('http://localhost/api/agent-capabilities/requests?status=pending'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ canDecide: false, requests: [] });
    expect(mockList.mock.calls[0][1]).toMatchObject({ status: ['pending'] });
  });
});

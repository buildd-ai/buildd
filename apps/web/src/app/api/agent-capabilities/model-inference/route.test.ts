import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mocks (before importing the route) ────────────────────────────────────────

const mockAuth = mock((_key: string | null) => Promise.resolve(null as any));
const mockResolvePrincipal = mock((_a: any, _i: any) => Promise.resolve(null as any));
const mockAudit = mock((_row: any) => Promise.resolve());
const mockInvoke = mock((_p: any, _r: any, _d: any) => Promise.resolve(null as any));

mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: mockAuth,
  // The real rules, so the route's confinement is what is tested.
  taskScopeAllowsWorker: (a: any, w: any) => !a.taskScope || w.taskId === a.taskScope.taskId,
  taskScopeAllowsWorkspace: (a: any, ws: any) => !a.taskScope || ws === a.taskScope.workspaceId,
}));
mock.module('@/lib/agent-capabilities/worker-principal', () => ({ resolveWorkerPrincipal: mockResolvePrincipal }));
mock.module('@/lib/agent-capabilities/audit', () => ({ recordCapabilityDecision: mockAudit }));
const mockFindLiveGrant = mock((_q: any) => Promise.resolve(null as any));
mock.module('@/lib/capability-grants-store', () => ({ capabilityGrantSource: { findLiveGrant: mockFindLiveGrant } }));

// The adapter is real except for the call itself, which is spied so the route's
// wiring (default deps: no grant service, no ledger) is observable.
const real = { ...(await import('@/lib/capability-model-inference')) };
mock.module('@/lib/capability-model-inference', () => ({ ...real, invokeModelInference: mockInvoke }));

import { POST } from './route';

// ── fixtures (illustrative) ───────────────────────────────────────────────────

const TASK = '22222222-2222-4222-8222-222222222222';
const WS = '33333333-3333-4333-8333-333333333333';
const WORKER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = { id: '55555555-5555-4555-8555-555555555555', teamId: 'team-1', level: 'worker' };
const TASK_TOKEN_ACCOUNT = { ...ACCOUNT, taskScope: { taskId: TASK, workspaceId: WS, expiresAt: Date.now() + 60_000 } };
const PRINCIPAL = { kind: 'agent_run', via: 'runner_key', workerId: WORKER, taskId: TASK, workspaceId: WS, teamId: 'team-1', accountId: ACCOUNT.id };

const BODY = {
  workerId: WORKER,
  model: 'typesafe/jev-1.13',
  state: 'The build failed on a flaky network test.',
  questions: { verdict: { type: 'choice', instructions: 'Classify the failure.', criteria: { flaky: null, real: null } } },
};

function req(opts: { apiKey?: string | null; body?: unknown; raw?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey !== null) headers.authorization = `Bearer ${opts.apiKey ?? 'bldt_token'}`;
  return new NextRequest('http://localhost/api/agent-capabilities/model-inference', {
    method: 'POST', headers, body: opts.raw ?? JSON.stringify(opts.body ?? BODY),
  });
}

beforeEach(() => {
  mockAuth.mockReset();
  mockResolvePrincipal.mockReset();
  mockAudit.mockClear();
  mockFindLiveGrant.mockClear();
  mockInvoke.mockReset();
  mockAuth.mockImplementation((key: string | null) => Promise.resolve(key ? TASK_TOKEN_ACCOUNT : null));
  mockResolvePrincipal.mockResolvedValue({ ok: true, principal: PRINCIPAL, workspace: { id: WS } });
  mockInvoke.mockImplementation((p: any, r: any, d: any) => real.invokeModelInference(p, r, d));
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/agent-capabilities/model-inference', () => {
  it('401s without a credential', async () => {
    const res = await POST(req({ apiKey: null }));
    expect(res.status).toBe(401);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('refuses a trigger token', async () => {
    mockAuth.mockResolvedValue({ ...ACCOUNT, level: 'trigger' });
    expect((await POST(req())).status).toBe(403);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('400s without a workerId, or with a non-JSON body', async () => {
    const { workerId: _w, ...noWorker } = BODY;
    expect((await POST(req({ body: noWorker }))).status).toBe(400);
    expect((await POST(req({ raw: '{not json' }))).status).toBe(400);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('413s an oversize body before parsing it', async () => {
    const res = await POST(req({ body: { ...BODY, state: 'x'.repeat(300 * 1024) } }));
    expect(res.status).toBe(413);
    expect(mockResolvePrincipal).not.toHaveBeenCalled();
  });

  it("404s a task token reaching another task's worker, and audits it", async () => {
    mockResolvePrincipal.mockResolvedValue({ ok: true, principal: { ...PRINCIPAL, taskId: '88888888-8888-4888-8888-888888888888' }, workspace: { id: WS } });
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ capability: 'model.inference', decision: 'refused', reasonCode: 'task_scope_mismatch', principalVia: 'task_token' });
  });

  it('passes a principal refusal through (dead worker ⇒ 409 with its code)', async () => {
    mockResolvePrincipal.mockResolvedValue({ ok: false, status: 409, error: 'Worker is not live', reasonCode: 'worker_not_live' });
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('worker_not_live');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('refuses an agent-supplied endpoint or key before anything runs', async () => {
    const res = await POST(req({ body: { ...BODY, baseURL: 'https://evil.example', apiKey: 'sk-x' } }));
    expect(res.status).toBe(400);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('with no live grant from the capability grant service, a valid request is 403 no_grant', async () => {
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'No live model.inference grant for this task', code: 'no_grant' });
    // Grants from the capability grant service; the ledger still fails closed.
    const deps = mockInvoke.mock.calls[0][2];
    expect(deps.grants).not.toBe(real.NO_GRANT_SERVICE);
    expect(mockFindLiveGrant).toHaveBeenCalled();
    expect(deps.ledger).toBe(real.NO_LEDGER);
    expect(mockInvoke.mock.calls[0][0].via).toBe('task_token');
    expect(mockAudit.mock.calls.at(-1)![0]).toMatchObject({
      capability: 'model.inference', decision: 'refused', reasonCode: 'no_grant',
      workspaceId: WS, taskId: TASK, workerId: WORKER, resource: `task:${TASK}`,
    });
  });

  it('a runner key (no task scope) is recorded as runner_key', async () => {
    mockAuth.mockResolvedValue(ACCOUNT);
    await POST(req({ apiKey: 'bld_key' }));
    expect(mockInvoke.mock.calls[0][0].via).toBe('runner_key');
  });

  it('returns answers and the receipt on success, with no credential in the body', async () => {
    const receipt = { grantId: 'g', provider: 'openrouter', model: 'typesafe/jev-1.13-20260917', operation: 'decide', inputTokens: 1, outputTokens: 1, costUsd: 0.0001, debitedUsd: 0.0001, costSource: 'provider', latencyMs: 5 };
    mockInvoke.mockResolvedValue({ ok: true, answers: { verdict: { type: 'choice', choice: 'flaky' } }, receipt });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ answers: { verdict: { type: 'choice', choice: 'flaky' } }, receipt });
  });

  it('returns the receipt with a provider failure', async () => {
    const receipt = { grantId: 'g', debitedUsd: 0.01, costSource: 'reservation' };
    mockInvoke.mockResolvedValue({ ok: false, status: 502, code: 'provider_error', error: 'The provider returned HTTP 500', receipt });
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'The provider returned HTTP 500', code: 'provider_error', receipt });
  });
});

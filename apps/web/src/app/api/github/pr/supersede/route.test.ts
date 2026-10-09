import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
const mockResolveWorkerByPrNumber = mock((..._args: any[]) => Promise.resolve({ error: 'PR not found', status: 404 } as any));
const mockRecordPrSupersession = mock((..._args: any[]) => Promise.resolve({ ok: false, error: 'not called', status: 500 } as any));
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
/** The CALLER's own task, as task-token-auth reads it (§17.1 (b)). */
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/pr-resolve', () => ({ resolveWorkerByPrNumber: mockResolveWorkerByPrNumber }));
mock.module('@/lib/pr-supersession', () => ({ recordPrSupersession: mockRecordPrSupersession }));
mock.module('@buildd/core/db', () => ({
  db: { query: { workers: { findFirst: mockWorkersFindFirst }, tasks: { findFirst: mockTasksFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'id' } }));
mock.module('drizzle-orm', () => ({ eq: (a: any, b: any) => ({ type: 'eq', a, b }), and: (...c: any[]) => ({ type: 'and', c }) }));

import { POST } from './route';

function makeRequest(body?: Record<string, unknown>, apiKey = 'test-key'): NextRequest {
  return new NextRequest('http://localhost/api/github/pr/supersede', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function reset() {
  mockAuthenticateApiKey.mockReset();
  mockAuthenticateApiKey.mockImplementation(() => Promise.resolve({ id: 'acc-1', teamId: 'team-1', name: 'Agent Bob' } as any));
  mockResolveWorkerByPrNumber.mockReset();
  mockResolveWorkerByPrNumber.mockImplementation(() => Promise.resolve({ id: 'w-1', workspace: { teamId: 'team-1' } } as any));
  mockRecordPrSupersession.mockReset();
  mockRecordPrSupersession.mockImplementation(() => Promise.resolve({
    ok: true,
    supersededPrNumber: 2287,
    supersedingPrNumber: 2293,
    supersedingPrUrl: 'https://github.com/org/repo/pull/2293',
  } as any));
  mockWorkersFindFirst.mockReset();
  mockWorkersFindFirst.mockImplementation(() => Promise.resolve({ id: 'w-1', workspace: { teamId: 'team-1' } } as any));
  mockTasksFindFirst.mockReset();
  mockTasksFindFirst.mockImplementation(() => Promise.resolve(null as any));
}

describe('POST /api/github/pr/supersede', () => {
  beforeEach(reset);

  it('401s without a valid API key', async () => {
    mockAuthenticateApiKey.mockImplementation(() => Promise.resolve(null as any));
    const res = await POST(makeRequest({ prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(401);
  });

  it('400s when neither workerId nor prNumber is supplied', async () => {
    const res = await POST(makeRequest({ supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(400);
  });

  it('400s when supersedingPrNumber is missing', async () => {
    const res = await POST(makeRequest({ prNumber: 2287, reason: 'x' }));
    expect(res.status).toBe(400);
  });

  it('400s when reason is blank', async () => {
    const res = await POST(makeRequest({ prNumber: 2287, supersedingPrNumber: 2293, reason: '  ' }));
    expect(res.status).toBe(400);
  });

  it('resolves the worker from prNumber via the shared resolver and calls recordPrSupersession', async () => {
    const res = await POST(makeRequest({ prNumber: 2287, supersedingPrNumber: 2293, reason: 'branch deleted' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.supersedingPrNumber).toBe(2293);
    expect(mockResolveWorkerByPrNumber).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1' }),
      2287,
      null,
    );
    expect(mockRecordPrSupersession).toHaveBeenCalledWith(expect.objectContaining({
      workerId: 'w-1',
      supersedingPrNumber: 2293,
      reason: 'branch deleted',
      recordedBy: 'Agent Bob',
    }));
  });

  it('passes a cross-repo supersedingRepo through to the write (which scopes it)', async () => {
    const res = await POST(makeRequest({ prNumber: 6, supersedingPrNumber: 3366, supersedingRepo: 'org/other', reason: 'moved' }));
    expect(res.status).toBe(200);
    expect(mockRecordPrSupersession).toHaveBeenCalledWith(expect.objectContaining({ supersedingRepo: 'org/other', supersedingPrNumber: 3366 }));
  });

  it('rejects cross-team access when resolveWorkerByPrNumber returns a worker from another team', async () => {
    mockResolveWorkerByPrNumber.mockImplementation(() => Promise.resolve({ id: 'w-1', workspace: { teamId: 'other-team' } } as any));
    const res = await POST(makeRequest({ prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(403);
  });

  it('accepts a direct workerId and still enforces team scoping', async () => {
    mockWorkersFindFirst.mockImplementation(() => Promise.resolve({ id: 'w-1', workspace: { teamId: 'other-team' } } as any));
    const res = await POST(makeRequest({ workerId: 'w-1', supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(403);
  });

  it('surfaces the write-time rejection status and message from recordPrSupersession', async () => {
    mockRecordPrSupersession.mockImplementation(() => Promise.resolve({ ok: false, error: 'PR #2293 is not merged (state: open)', status: 409 } as any));
    const res = await POST(makeRequest({ prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain('not merged');
  });

  it('prioritizes explicit prNumber over implicit workerId when both are supplied (MCP auto-fill scenario)', async () => {
    // Regression test for: when MCP handler auto-fills workerId with ctx.workerId,
    // the route should still resolve by the explicit prNumber if provided.
    // This simulates: record_pr_supersession({prNumber: 2287, supersedingPrNumber: 2293})
    // gets auto-filled to {workerId: 'caller-w-id', prNumber: 2287, supersedingPrNumber: 2293}
    // Expected: resolve worker from prNumber=2287 (w-2), not from workerId='caller-w-id'

    // The caller's own worker (auto-filled)
    const callerWorkerId = 'caller-w-id';
    // The actual worker for PR #2287 (different from caller)
    const prOwnerWorkerId = 'w-2';

    mockWorkersFindFirst.mockImplementation((opts: any) => {
      if (opts.where.a === 'id' && opts.where.b === callerWorkerId) {
        // Caller's own worker (has no PR)
        return Promise.resolve({ id: callerWorkerId, workspace: { teamId: 'team-1' } } as any);
      }
      return Promise.resolve(null as any);
    });

    mockResolveWorkerByPrNumber.mockImplementation((...args: any[]) => {
      const prNum = args[1];
      if (prNum === 2287) {
        // PR #2287 belongs to a different worker
        return Promise.resolve({ id: prOwnerWorkerId, workspace: { teamId: 'team-1' } } as any);
      }
      return Promise.resolve({ error: 'PR not found', status: 404 } as any);
    });

    // Both workerId and prNumber supplied (simulating MCP auto-fill)
    const res = await POST(makeRequest({
      workerId: callerWorkerId,
      prNumber: 2287,
      supersedingPrNumber: 2293,
      reason: 'branch deleted',
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // Most important: should have called resolveWorkerByPrNumber, indicating
    // it prioritized the explicit prNumber over the implicit workerId
    expect(mockResolveWorkerByPrNumber).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1' }),
      2287,
      null,
    );

    // Should have passed the PR owner's worker ID to recordPrSupersession,
    // not the caller's auto-filled workerId
    expect(mockRecordPrSupersession).toHaveBeenCalledWith(expect.objectContaining({
      workerId: prOwnerWorkerId,
      supersedingPrNumber: 2293,
      reason: 'branch deleted',
      recordedBy: 'Agent Bob',
    }));
  });
});

describe('per-task token', () => {
  const SCOPED = { id: 'acc-1', teamId: 'team-1', name: 'Agent Bob', level: 'worker', taskScope: { taskId: 't-1', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };
  const worker = (over: Record<string, unknown> = {}) => ({
    id: 'w-1', taskId: 't-1', accountId: 'acc-1', prNumber: 2287, workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1' }, ...over,
  });

  beforeEach(() => {
    reset();
    mockAuthenticateApiKey.mockImplementation(() => Promise.resolve(SCOPED as any));
  });

  it('supersedes its own task’s PR, resolving in its own workspace and confining the target repo', async () => {
    mockResolveWorkerByPrNumber.mockImplementation(() => Promise.resolve(worker() as any));
    const res = await POST(makeRequest({ prNumber: 2287, supersedingPrNumber: 2293, reason: 'branch deleted' }));
    expect(res.status).toBe(200);
    expect(mockResolveWorkerByPrNumber).toHaveBeenCalledWith(expect.anything(), 2287, 'ws-1');
    expect(mockRecordPrSupersession).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'w-1', targetRepoWithinWorkspace: true }));
  });

  it('supersedes its own worker’s PR by workerId', async () => {
    mockWorkersFindFirst.mockImplementation(() => Promise.resolve(worker() as any));
    const res = await POST(makeRequest({ workerId: 'w-1', supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(200);
  });

  it('refuses another task’s PR in its workspace, before writing', async () => {
    mockResolveWorkerByPrNumber.mockImplementation(() => Promise.resolve(worker({ id: 'w-2', taskId: 't-2' }) as any));
    const res = await POST(makeRequest({ prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(403);
    expect(mockRecordPrSupersession).not.toHaveBeenCalled();
  });

  it('refuses a worker of its own task that tracks no PR', async () => {
    mockWorkersFindFirst.mockImplementation(() => Promise.resolve(worker({ prNumber: null }) as any));
    const res = await POST(makeRequest({ workerId: 'w-1', supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(403);
    expect(mockRecordPrSupersession).not.toHaveBeenCalled();
  });

  it('account keys keep the mission-wide target scope', async () => {
    mockAuthenticateApiKey.mockImplementation(() => Promise.resolve({ id: 'acc-1', teamId: 'team-1', name: 'Agent Bob' } as any));
    await POST(makeRequest({ prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(mockRecordPrSupersession.mock.calls[0][0]).not.toHaveProperty('targetRepoWithinWorkspace');
  });
});

// S21 (docs/specs/workflow-state-kernel.md §16, §17.1): who may record T20. The rule is the
// CALLER's task, never the owner's (the PR #3754 case): the owner task naming a PR gives a
// different task's token nothing.
describe('S21: the supersede authorization matrix (§17.1)', () => {
  const scoped = (taskId: string, workspaceId = 'ws-1') => ({ id: 'acc-1', teamId: 'team-1', name: 'Agent Bob', level: 'worker', taskScope: { taskId, workspaceId, expiresAt: Date.now() + 60_000 } });
  /** PR #2287, opened by task t-owner, whose own description names it. */
  const ownerWorker = { id: 'w-own', taskId: 't-owner', accountId: 'acc-1', prNumber: 2287, workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1' } };
  const callerTask = (id: string, over: Record<string, unknown> = {}) => ({ id, workspaceId: 'ws-1', title: 'friction: fix the check', description: null, context: null, reviewerRetryPrNumber: null, ciRetryPrNumber: null, conflictRetryPrNumber: null, ...over });
  const call = async (account: unknown) => {
    mockAuthenticateApiKey.mockImplementation(() => Promise.resolve(account as any));
    return POST(makeRequest({ prNumber: 2287, supersedingPrNumber: 2293, reason: 'landed under #2293' }));
  };

  beforeEach(() => {
    reset();
    mockResolveWorkerByPrNumber.mockImplementation(() => Promise.resolve(ownerWorker as any));
  });

  it('(a) the owner task\'s own token: allowed, recorded as that task', async () => {
    const res = await call(scoped('t-owner'));
    expect(res.status).toBe(200);
    expect(mockRecordPrSupersession).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'w-own', recordedBy: 'agent:t-owner', targetRepoWithinWorkspace: true }));
  });

  it('(b) a task token whose OWN task names the PR: allowed, recorded as the caller', async () => {
    mockTasksFindFirst.mockImplementation(() => Promise.resolve(callerTask('t-caller', { description: 'The check landed in #2293; record #2287 as superseded.' }) as any));
    const res = await call(scoped('t-caller'));
    expect(res.status).toBe(200);
    expect(mockRecordPrSupersession).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'w-own', recordedBy: 'agent:t-caller' }));
  });

  it('(b) a retry bound to the PR names it', async () => {
    mockTasksFindFirst.mockImplementation(() => Promise.resolve(callerTask('t-retry', { reviewerRetryPrNumber: 2287 }) as any));
    expect((await call(scoped('t-retry'))).status).toBe(200);
  });

  it('a sibling task whose own task does not name the PR: refused before any write, even though the owner\'s task names it', async () => {
    mockTasksFindFirst.mockImplementation(() => Promise.resolve(callerTask('t-sibling', { description: 'unrelated work on #2290' }) as any));
    const res = await call(scoped('t-sibling'));
    expect(res.status).toBe(403);
    expect(mockRecordPrSupersession).not.toHaveBeenCalled();
  });

  it('a task token of another workspace: refused, even when its task names the number', async () => {
    mockTasksFindFirst.mockImplementation(() => Promise.resolve(callerTask('t-other', { workspaceId: 'ws-2', description: 'see #2287' }) as any));
    const res = await call(scoped('t-other', 'ws-2'));
    expect(res.status).toBe(403);
    expect(mockRecordPrSupersession).not.toHaveBeenCalled();
  });

  it('a person or account key on the team: allowed, recorded under its own name, mission-wide target scope', async () => {
    const res = await call({ id: 'acc-9', teamId: 'team-1', name: 'owner@example.com' });
    expect(res.status).toBe(200);
    expect(mockRecordPrSupersession.mock.calls[0][0]).toMatchObject({ recordedBy: 'owner@example.com' });
    expect(mockRecordPrSupersession.mock.calls[0][0]).not.toHaveProperty('targetRepoWithinWorkspace');
  });

  it('another team: refused', async () => {
    mockResolveWorkerByPrNumber.mockImplementation(() => Promise.resolve({ ...ownerWorker, accountId: 'acc-x', workspace: { id: 'ws-1', teamId: 'team-2' } } as any));
    const res = await call({ id: 'acc-9', teamId: 'team-1', name: 'owner@example.com' });
    expect(res.status).toBe(403);
    expect(mockRecordPrSupersession).not.toHaveBeenCalled();
  });
});

// An agent run on its runner's key (no per-task token) names itself with workerId,
// as close_pr and update_pr do. It may record a supersession only for a PR its own
// task owns: its own worker's PR, or one its task names. People keep full reach.
describe('agent run on its runner key: the PR must be its own', () => {
  const RUNNER = { id: 'acc-1', teamId: 'team-1', name: 'Runner', level: 'worker' };
  const callerWorker = (over: Record<string, unknown> = {}) => ({
    id: 'w-caller', taskId: 't-caller', accountId: 'acc-1', prNumber: null, workspaceId: 'ws-1',
    workspace: { id: 'ws-1', teamId: 'team-1' },
    task: { id: 't-caller', title: 'unrelated work', description: null, context: null, roleSlug: 'builder', mode: 'execution', missionId: null, reviewerRetryPrNumber: null, ciRetryPrNumber: null, conflictRetryPrNumber: null },
    ...over,
  });
  /** PR #2287, opened by another task's run on the same runner account. */
  const otherRunsWorker = { id: 'w-other', taskId: 't-other', accountId: 'acc-1', prNumber: 2287, workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1' } };

  function actingWorkerIs(worker: unknown) {
    mockWorkersFindFirst.mockImplementation((opts: any) => Promise.resolve(
      opts?.where?.a === 'id' && opts?.where?.b === 'w-caller' ? worker as any : null,
    ));
  }

  beforeEach(() => {
    reset();
    mockAuthenticateApiKey.mockImplementation(() => Promise.resolve(RUNNER as any));
    mockResolveWorkerByPrNumber.mockImplementation(() => Promise.resolve(otherRunsWorker as any));
  });

  it('refuses a PR another task\'s run opened, before writing', async () => {
    actingWorkerIs(callerWorker());
    const res = await POST(makeRequest({ workerId: 'w-caller', prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('only its own PR');
    expect(mockRecordPrSupersession).not.toHaveBeenCalled();
  });

  it('looks up the acting run by the workerId it named', async () => {
    actingWorkerIs(callerWorker());
    await POST(makeRequest({ workerId: 'w-caller', prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    const lookup = mockWorkersFindFirst.mock.calls.map((c: any) => c[0]).find((o: any) => o?.where?.b === 'w-caller');
    expect(lookup?.where).toEqual({ type: 'eq', a: 'id', b: 'w-caller' });
    expect(lookup?.with?.task).toBeTruthy();
  });

  it('allows a PR its own task names', async () => {
    actingWorkerIs(callerWorker({ task: { ...callerWorker().task, description: 'The work landed in #2293; record #2287 as superseded.' } }));
    const res = await POST(makeRequest({ workerId: 'w-caller', prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(200);
    expect(mockRecordPrSupersession).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'w-other' }));
  });

  it('allows its own worker\'s PR', async () => {
    const own = callerWorker({ prNumber: 2287 });
    actingWorkerIs(own);
    mockResolveWorkerByPrNumber.mockImplementation(() => Promise.resolve(own as any));
    const res = await POST(makeRequest({ workerId: 'w-caller', prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(200);
    expect(mockRecordPrSupersession).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'w-caller' }));
  });

  it('allows a person session on the shared account', async () => {
    mockAuthenticateApiKey.mockImplementation(() => Promise.resolve({ ...RUNNER, sessionUserId: 'user-1' } as any));
    actingWorkerIs(callerWorker());
    const res = await POST(makeRequest({ workerId: 'w-caller', prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(200);
  });

  it('allows a teammate on another account', async () => {
    mockAuthenticateApiKey.mockImplementation(() => Promise.resolve({ id: 'acc-9', teamId: 'team-1', name: 'teammate' } as any));
    actingWorkerIs(callerWorker());
    const res = await POST(makeRequest({ workerId: 'w-caller', prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(200);
  });

  it('refuses a named acting worker from another team', async () => {
    actingWorkerIs(callerWorker({ accountId: 'acc-x', workspace: { id: 'ws-9', teamId: 'team-2' }, workspaceId: 'ws-9' }));
    const res = await POST(makeRequest({ workerId: 'w-caller', prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(403);
    expect(mockRecordPrSupersession).not.toHaveBeenCalled();
  });

  it('404s when the named acting worker does not exist', async () => {
    actingWorkerIs(null);
    const res = await POST(makeRequest({ workerId: 'w-caller', prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(404);
    expect(mockRecordPrSupersession).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
const mockResolveWorkerByPrNumber = mock((..._args: any[]) => Promise.resolve({ error: 'PR not found', status: 404 } as any));
const mockRecordPrSupersession = mock((..._args: any[]) => Promise.resolve({ ok: false, error: 'not called', status: 500 } as any));
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockTasksFindFirst = mock((..._args: any[]) => Promise.resolve(null as any));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/pr-resolve', () => ({ resolveWorkerByPrNumber: mockResolveWorkerByPrNumber }));
mock.module('@/lib/pr-supersession', () => ({ recordPrSupersession: mockRecordPrSupersession }));
mock.module('@buildd/core/db', () => ({
  db: { query: { workers: { findFirst: mockWorkersFindFirst }, tasks: { findFirst: mockTasksFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'id' }, tasks: { id: 'tid', workspaceId: 'twsid' } }));
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

  describe('caller task names the target PR', () => {
    const sibling = () => worker({ id: 'w-2', taskId: 't-2', prNumber: 3744 });
    const callerTask = (over: Record<string, unknown> = {}) => ({ id: 't-1', workspaceId: 'ws-1', title: 'Fix goal criterion', description: '', context: null, ...over });

    beforeEach(() => {
      mockResolveWorkerByPrNumber.mockImplementation(() => Promise.resolve(sibling() as any));
    });

    it('allows a PR named in the CALLER task title, loading the caller task by its token scope', async () => {
      mockTasksFindFirst.mockImplementation(() => Promise.resolve(callerTask({ title: 'Fix goal criterion (#3744)' }) as any));
      const res = await POST(makeRequest({ prNumber: 3744, supersedingPrNumber: 3748, reason: 'named' }));
      expect(res.status).toBe(200);
      const where = (mockTasksFindFirst.mock.calls[0][0] as any).where;
      expect(JSON.stringify(where)).toContain('t-1');
      expect(JSON.stringify(where)).toContain('ws-1');
      expect(mockRecordPrSupersession).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'w-2', targetRepoWithinWorkspace: true }));
    });

    it('allows a PR named in the caller task context', async () => {
      mockTasksFindFirst.mockImplementation(() => Promise.resolve(callerTask({ context: { prNumber: 3744 } }) as any));
      const res = await POST(makeRequest({ prNumber: 3744, supersedingPrNumber: 3748, reason: 'named' }));
      expect(res.status).toBe(200);
    });

    it('refuses when only the PR OWNER’s task names the PR, not the caller’s', async () => {
      mockResolveWorkerByPrNumber.mockImplementation(() => Promise.resolve(
        { ...sibling(), task: { title: 'Ship #3744', description: '' } } as any));
      mockWorkersFindFirst.mockImplementation(() => Promise.resolve(
        { ...sibling(), task: { title: 'Ship #3744', description: '' } } as any));
      mockTasksFindFirst.mockImplementation(() => Promise.resolve(callerTask() as any));
      const res = await POST(makeRequest({ prNumber: 3744, supersedingPrNumber: 3748, reason: 'x' }));
      expect(res.status).toBe(403);
      expect(mockRecordPrSupersession).not.toHaveBeenCalled();
    });

    it('refuses a different PR than the one the caller task names', async () => {
      mockTasksFindFirst.mockImplementation(() => Promise.resolve(callerTask({ title: 'Fix #3000' }) as any));
      const res = await POST(makeRequest({ prNumber: 3744, supersedingPrNumber: 3748, reason: 'x' }));
      expect(res.status).toBe(403);
      expect(mockRecordPrSupersession).not.toHaveBeenCalled();
    });

    it('refuses a PR in a foreign workspace even if the caller task names it', async () => {
      mockResolveWorkerByPrNumber.mockImplementation(() => Promise.resolve(
        { ...sibling(), workspaceId: 'ws-9', workspace: { id: 'ws-9', teamId: 'team-1' } } as any));
      mockTasksFindFirst.mockImplementation(() => Promise.resolve(callerTask({ title: 'Fix #3744' }) as any));
      const res = await POST(makeRequest({ prNumber: 3744, supersedingPrNumber: 3748, reason: 'x' }));
      expect(res.status).toBe(403);
      expect(mockRecordPrSupersession).not.toHaveBeenCalled();
    });

    it('refuses when the caller task is not found in its workspace', async () => {
      mockTasksFindFirst.mockImplementation(() => Promise.resolve(null as any));
      const res = await POST(makeRequest({ prNumber: 3744, supersedingPrNumber: 3748, reason: 'x' }));
      expect(res.status).toBe(403);
    });

    it('does not let workerId alone use naming (no explicit prNumber)', async () => {
      mockWorkersFindFirst.mockImplementation(() => Promise.resolve(sibling() as any));
      mockTasksFindFirst.mockImplementation(() => Promise.resolve(callerTask({ title: 'Fix #3744' }) as any));
      const res = await POST(makeRequest({ workerId: 'w-2', supersedingPrNumber: 3748, reason: 'x' }));
      expect(res.status).toBe(403);
    });
  });
});

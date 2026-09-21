import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
const mockResolveWorkerByPrNumber = mock((..._args: any[]) => Promise.resolve({ error: 'PR not found', status: 404 } as any));
const mockRecordPrSupersession = mock((..._args: any[]) => Promise.resolve({ ok: false, error: 'not called', status: 500 } as any));
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/pr-resolve', () => ({ resolveWorkerByPrNumber: mockResolveWorkerByPrNumber }));
mock.module('@/lib/pr-supersession', () => ({ recordPrSupersession: mockRecordPrSupersession }));
mock.module('@buildd/core/db', () => ({
  db: { query: { workers: { findFirst: mockWorkersFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'id' } }));
mock.module('drizzle-orm', () => ({ eq: (a: any, b: any) => ({ type: 'eq', a, b }) }));

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

  it('prioritizes prNumber over a co-supplied workerId (e.g. ctx.workerId implicitly injected by the MCP layer)', async () => {
    // Simulates the real bug: recordPrSupersession({ workerId: ctx.workerId, prNumber }) where
    // the caller's OWN worker (workerId) happens to have a stale/superseded PR association,
    // but prNumber explicitly names the PR to supersede. workers.findFirst below stands in for
    // that stale worker row — if the route ever falls back to it instead of resolving by
    // prNumber, resolvedWorkerId would wrongly become 'w-other'.
    mockWorkersFindFirst.mockImplementation(() => Promise.resolve({ id: 'w-other', workspace: { teamId: 'team-1' } } as any));
    const res = await POST(makeRequest({ workerId: 'w-other', prNumber: 2287, supersedingPrNumber: 2293, reason: 'branch deleted' }));
    expect(res.status).toBe(200);
    expect(mockResolveWorkerByPrNumber).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1' }),
      2287,
      null,
    );
    expect(mockWorkersFindFirst).not.toHaveBeenCalled();
    expect(mockRecordPrSupersession).toHaveBeenCalledWith(expect.objectContaining({
      workerId: 'w-1',
    }));
  });

  it('surfaces the write-time rejection status and message from recordPrSupersession', async () => {
    mockRecordPrSupersession.mockImplementation(() => Promise.resolve({ ok: false, error: 'PR #2293 is not merged (state: open)', status: 409 } as any));
    const res = await POST(makeRequest({ prNumber: 2287, supersedingPrNumber: 2293, reason: 'x' }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain('not merged');
  });
});

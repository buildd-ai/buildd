import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockRefreshWorkerMergeStateIfStale = mock(() => Promise.resolve(false));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/pr-reconcile', () => ({
  refreshWorkerMergeStateIfStale: mockRefreshWorkerMergeStateIfStale,
}));

// Provide drizzle-orm stubs so imports don't fail
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  isNull: (a: any) => ({ a, op: 'isNull' }),
  isNotNull: (a: any) => ({ a, op: 'isNotNull' }),
  inArray: (a: any, b: any) => ({ a, b, op: 'inArray' }),
}));

const mockExecute = mock(() => Promise.resolve({ rows: [] }));
mock.module('@buildd/core/db', () => ({
  db: { execute: mockExecute },
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'id', prNumber: 'prNumber', prUrl: 'prUrl', mergedAt: 'mergedAt', prLifecycleStatus: 'prLifecycleStatus' },
}));

import { POST } from './route';

function makeRequest(body?: unknown) {
  return new NextRequest('http://localhost:3000/api/admin/backfill-merged-prs', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('POST /api/admin/backfill-merged-prs', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockRefreshWorkerMergeStateIfStale.mockReset();
    mockExecute.mockReset();
    mockExecute.mockResolvedValue({ rows: [] });
  });

  it('returns 401 with no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin API key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'user' });

    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
  });

  it('returns 200 with summary when no stale workers found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'admin-user' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockExecute.mockResolvedValue({ rows: [] });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ total: 0, refreshed: 0 });
  });

  it('calls refreshWorkerMergeStateIfStale for each stale worker', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'admin-user' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockExecute.mockResolvedValue({
      rows: [
        { id: 'w1', pr_number: 10, pr_url: 'https://github.com/o/r/pull/10', installation_id: 1 },
        { id: 'w2', pr_number: 20, pr_url: 'https://github.com/o/r/pull/20', installation_id: 1 },
      ],
    });
    mockRefreshWorkerMergeStateIfStale.mockResolvedValue(true);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.refreshed).toBe(2);
    expect(mockRefreshWorkerMergeStateIfStale).toHaveBeenCalledTimes(2);
  });

  it('allows admin-level API key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'admin' });
    mockExecute.mockResolvedValue({ rows: [] });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });
});

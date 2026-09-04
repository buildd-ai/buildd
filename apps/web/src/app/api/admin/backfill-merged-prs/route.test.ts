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
const mockSet = mock((_v: Record<string, unknown>) => ({ where: mock(() => Promise.resolve()) }));
mock.module('@buildd/core/db', () => ({
  db: { execute: mockExecute, update: () => ({ set: mockSet }) },
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: {
    id: 'id', prNumber: 'prNumber', prUrl: 'prUrl', mergedAt: 'mergedAt',
    prLifecycleStatus: 'prLifecycleStatus', prCheckFailureCount: 'prCheckFailureCount',
  },
}));

const DAY_MS = 24 * 60 * 60 * 1000;

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
    mockSet.mockClear();
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

  // A browser session is not an accepted credential here: `getCurrentUser`
  // carries no admin level and this codebase has no platform-admin concept for
  // sessions, so being signed in must not substitute for an admin key.
  it('returns 401 for a signed-in session with no admin-level API key', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'some-user' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(mockRefreshWorkerMergeStateIfStale).not.toHaveBeenCalled();
  });

  it('returns 403 for a signed-in session presenting a non-admin API key', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'some-user' });
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'user' });

    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(mockRefreshWorkerMergeStateIfStale).not.toHaveBeenCalled();
  });

  it('returns 200 with summary when no stale workers found', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'admin' });
    mockExecute.mockResolvedValue({ rows: [] });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ total: 0, refreshed: 0 });
  });

  it('calls refreshWorkerMergeStateIfStale for each stale worker', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'admin' });
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

  // ── Candidate selection ──────────────────────────────────────────────────
  //
  // This route existed while four merged PRs sat on Home for up to 90 days,
  // and could not have fixed any of them: it resolved the installation through
  // the legacy workspaces FK only (NULL or dead for the affected workspaces)
  // and required the originating task to be 'completed'.

  it('prefers the repo-mediated installation over the legacy workspace FK', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'admin' });
    mockExecute.mockResolvedValue({ rows: [] });

    await POST(makeRequest());

    const query = JSON.stringify(mockExecute.mock.calls[0][0]);
    expect(query).toContain('github_repos');
    expect(query).toContain('gr_inst.installation_id');
  });

  it('does not restrict the backfill to completed tasks', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'admin' });
    mockExecute.mockResolvedValue({ rows: [] });

    await POST(makeRequest());

    // A failed or cancelled task can still have left a PR that later merged,
    // and Home renders it either way.
    expect(JSON.stringify(mockExecute.mock.calls[0][0])).not.toContain("t.status = 'completed'");
  });

  it('retires an old row with no reachable installation to terminal unresolvable', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'admin' });
    mockExecute.mockResolvedValue({
      rows: [{
        id: 'w1',
        pr_number: 77,
        pr_url: 'https://github.com/o/r/pull/77',
        installation_id: null,
        pr_check_failure_count: 5,
        pr_opened_at: new Date(Date.now() - 90 * DAY_MS).toISOString(),
      }],
    });

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(data.unresolvable).toBe(1);
    expect(mockRefreshWorkerMergeStateIfStale).not.toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ prLifecycleStatus: 'unresolvable' }),
    );
  });

  it('counts, but does not retire, a young row with no reachable installation', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'admin' });
    mockExecute.mockResolvedValue({
      rows: [{
        id: 'w1',
        pr_number: 78,
        pr_url: 'https://github.com/o/r/pull/78',
        installation_id: null,
        pr_check_failure_count: 0,
        pr_opened_at: new Date().toISOString(),
      }],
    });

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(data.unresolvable).toBe(0);
    expect(data.skipped).toBe(1);
    expect(mockSet).toHaveBeenCalledWith(
      expect.not.objectContaining({ prLifecycleStatus: 'unresolvable' }),
    );
  });
});

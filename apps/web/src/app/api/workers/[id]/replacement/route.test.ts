import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/** POST /api/workers/[id]/replacement: a person links a closed PR's replacement (display only). */

const WORKER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let workerRow: any = null;
let currentUser: any = { id: 'u-1', email: 'owner@example.com' };
let apiAccountRow: any = null;
let access = true;
let adminKey = true;

const mockLink = mock(async (p: any) => ({ updated: true, url: `https://github.com/${p.repoFullName}/pull/${p.prNumber}` }));

mock.module('drizzle-orm', () => ({ eq: (...a: any[]) => ({ a }), and: (...a: any[]) => ({ a }), sql: () => ({}) }));
mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'id' }, workspaces: { repo: 'repo' } }));
mock.module('@buildd/core/db', () => ({ db: { query: { workers: { findFirst: () => Promise.resolve(workerRow) } } } }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: () => Promise.resolve(apiAccountRow) }));
mock.module('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: () => adminKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: () => Promise.resolve(access),
  verifyAccountWorkspaceAccess: () => Promise.resolve(access),
}));
mock.module('@/lib/pr-named-replacement-store', () => ({
  linkNamedReplacement: mockLink,
  recordNamedReplacement: mock(async () => 0),
}));

const { POST } = await import('./route');
const call = (body: unknown, id = WORKER, contentType = 'application/json') => POST(
  new NextRequest(`http://localhost/api/workers/${id}/replacement`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': contentType },
  }),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  workerRow = {
    id: WORKER, workspaceId: 'ws-1', prNumber: 132, prUrl: 'https://github.com/org/repo/pull/132', mergedAt: null,
    workspace: { repo: 'https://github.com/org/other' },
  };
  currentUser = { id: 'u-1', email: 'owner@example.com' };
  apiAccountRow = null;
  access = true;
  adminKey = true;
  mockLink.mockClear();
});

describe('POST /api/workers/[id]/replacement', () => {
  it('links the replacement in the PR\'s own repo and answers its URL', async () => {
    const res = await call({ prNumber: 140 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, prNumber: 140, url: 'https://github.com/org/repo/pull/140' });
    expect(mockLink).toHaveBeenCalledWith({ workerId: WORKER, repoFullName: 'org/repo', prNumber: 140 });
  });

  it('falls back to the workspace repo when the PR URL names none', async () => {
    workerRow.prUrl = null;
    expect((await call({ prNumber: 140 })).status).toBe(200);
    expect(mockLink.mock.calls[0]![0].repoFullName).toBe('org/other');
  });

  it('401s without a session or key', async () => {
    currentUser = null;
    expect((await call({ prNumber: 140 })).status).toBe(401);
  });

  it('415s a non-JSON request, so a plain cross-site form cannot fire it', async () => {
    expect((await call({ prNumber: 140 }, WORKER, 'text/plain')).status).toBe(415);
  });

  it('404s a non-UUID id without reading', async () => {
    expect((await call({ prNumber: 140 }, 'not-a-uuid')).status).toBe(404);
  });

  it('400s a prNumber that is not a positive integer', async () => {
    for (const prNumber of [0, -3, 1.5, '140', null]) {
      expect((await call({ prNumber })).status).toBe(400);
    }
    expect((await call(null)).status).toBe(400);
    expect(mockLink).not.toHaveBeenCalled();
  });

  it('400s a PR naming itself', async () => {
    expect((await call({ prNumber: 132 })).status).toBe(400);
    expect(mockLink).not.toHaveBeenCalled();
  });

  it('404s a worker outside the caller\'s team, a missing worker, and a worker with no PR', async () => {
    access = false;
    expect((await call({ prNumber: 140 })).status).toBe(404);
    access = true;
    workerRow.prNumber = null;
    expect((await call({ prNumber: 140 })).status).toBe(404);
    workerRow = null;
    expect((await call({ prNumber: 140 })).status).toBe(404);
    expect(mockLink).not.toHaveBeenCalled();
  });

  it('409s a merged PR, read up front or merged in between', async () => {
    workerRow.mergedAt = new Date();
    expect((await call({ prNumber: 140 })).status).toBe(409);
    expect(mockLink).not.toHaveBeenCalled();
    workerRow.mergedAt = null;
    mockLink.mockResolvedValueOnce({ updated: false, url: 'x' });
    expect((await call({ prNumber: 140 })).status).toBe(409);
  });

  it('only a person: an API key or task token is refused; an OAuth session with a user is allowed', async () => {
    currentUser = null;
    apiAccountRow = { id: 'a-1', name: 'runner' };
    expect((await call({ prNumber: 140 })).status).toBe(403);
    apiAccountRow = { id: 'a-1', name: 'runner', sessionUserId: 'u-9', taskScope: { taskId: 't' } };
    expect((await call({ prNumber: 140 })).status).toBe(403);
    apiAccountRow = { id: 'a-1', name: 'oauth', sessionUserId: 'u-9' };
    expect((await call({ prNumber: 140 })).status).toBe(200);
  });
});

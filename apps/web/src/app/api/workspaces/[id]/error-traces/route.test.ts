import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false as any));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

// The rollup lib runs for real; only the terminal db call is stubbed. The
// query's WHERE scoping is covered by rendering SQL in
// src/lib/workspace-error-traces.test.ts.
const mockRows = mock(() => Promise.resolve([] as any[]));
const limitArgs: unknown[] = [];
const chain: any = {
  from: () => chain,
  innerJoin: () => chain,
  where: () => chain,
  groupBy: () => chain,
  orderBy: () => chain,
  limit: (n: unknown) => { limitArgs.push(n); return mockRows(); },
};
const mockSelect = mock(() => chain);
mock.module('@buildd/core/db', () => ({ db: { select: mockSelect } }));

import { GET } from './route';

const WS = '00000000-0000-4000-8000-0000000000aa';

function req(qs = '', headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000/api/workspaces/${WS}/error-traces${qs}`, {
    headers: new Headers(headers),
  });
}
const params = (id = WS) => ({ params: Promise.resolve({ id }) });

describe('GET /api/workspaces/[id]/error-traces', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    mockRows.mockReset();
    mockRows.mockResolvedValue([]);
    mockSelect.mockClear();
    limitArgs.length = 0;
  });

  it('401s without a session or API key', async () => {
    const res = await GET(req(), params());
    expect(res.status).toBe(401);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('404s for a session user who is not a member of the workspace, without querying traces', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await GET(req(), params());
    expect(res.status).toBe(404);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-1', WS);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('404s for an API account without workspace access, without querying traces', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1' });
    const res = await GET(req('', { authorization: 'Bearer bld_x' }), params());
    expect(res.status).toBe(404);
    expect(mockVerifyAccountWorkspaceAccess).toHaveBeenCalledWith('acct-1', WS);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('400s on a non-UUID workspace id before any lookup', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await GET(req(), params('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(mockVerifyWorkspaceAccess).not.toHaveBeenCalled();
  });

  it('returns the per-pattern rollup in the order SQL produced it, with window and limit echoed', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockRows.mockResolvedValue([
      { pattern: 'git_fatal', count: 4, taskCount: 3, firstSeen: '2026-08-20T00:00:00Z', lastSeen: '2026-08-27T00:00:00Z', exampleExcerpt: 'fatal: x', exampleSource: 'bash', exampleTaskIds: ['t-1', 't-2', 't-3'] },
      { pattern: 'oom', count: 1, taskCount: 1, firstSeen: '2026-08-25T00:00:00Z', lastSeen: '2026-08-25T00:00:00Z', exampleExcerpt: 'Killed', exampleSource: null, exampleTaskIds: ['t-9'] },
    ]);
    const since = '2026-08-19T00:00:00.000Z';
    const res = await GET(req(`?since=${since}&limit=5`, { authorization: 'Bearer bld_x' }), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBe(WS);
    expect(body.since).toBe(since);
    expect(body.limit).toBe(5);
    expect(body.patterns.map((p: any) => p.pattern)).toEqual(['git_fatal', 'oom']);
    expect(body.patterns[0].count).toBe(4);
    expect(body.patterns[0].exampleTaskIds).toEqual(['t-1', 't-2', 't-3']);
    expect(limitArgs).toEqual([5]);
  });

  it('defaults to a 7-day window when since is absent', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 't', role: 'member' });
    const before = Date.now();
    const res = await GET(req(), params());
    const body = await res.json();
    const sinceMs = new Date(body.since).getTime();
    expect(before - sinceMs).toBeGreaterThanOrEqual(7 * 24 * 3600 * 1000 - 1000);
    expect(before - sinceMs).toBeLessThanOrEqual(7 * 24 * 3600 * 1000 + 1000);
    expect(body.patterns).toEqual([]);
  });
});

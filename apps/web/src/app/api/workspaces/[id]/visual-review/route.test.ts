/**
 * GET /api/workspaces/[id]/visual-review: the workspace's missions with
 * screens awaiting a human. Same access as the mission read. Illustrative ids.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

const mockGetCurrentUser = mock(async () => null as any);
const mockAuthenticateApiKey = mock(async () => null as any);
const mockResolveTeamIds = mock(async () => [] as string[]);
const mockVerifyAccountWorkspaceAccess = mock(async () => false);
const mockVerifyWorkspaceAccess = mock(async () => ({ teamId: 'team-a', role: 'member' }) as any);
const mockWorkspaceFindFirst = mock(async (_q: any) => null as any);
const mockLoad = mock(async (_ws: string, _teams: readonly string[]) => ({ missions: [] as any[], more: false }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  resolveAccountTeamIds: mockResolveTeamIds,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));
mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findFirst: mockWorkspaceFindFirst } } } }));
mock.module('@/lib/visual-review-load', () => ({ loadWorkspaceAwaitingReview: mockLoad }));

const { GET } = await import('./route');

const WS = '22222222-2222-4222-8222-222222222222';
const ws = { id: WS, name: 'Example', teamId: 'team-a' };

const call = (id = WS, key?: string) =>
  GET(new NextRequest(`http://localhost/api/workspaces/${id}/visual-review`, { headers: key ? { authorization: `Bearer ${key}` } : {} }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  for (const m of [mockGetCurrentUser, mockAuthenticateApiKey, mockResolveTeamIds, mockVerifyAccountWorkspaceAccess, mockVerifyWorkspaceAccess, mockWorkspaceFindFirst, mockLoad]) m.mockClear();
  mockGetCurrentUser.mockResolvedValue(null);
  mockAuthenticateApiKey.mockResolvedValue(null);
  mockResolveTeamIds.mockResolvedValue([]);
  mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
  mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-a', role: 'member' });
  mockWorkspaceFindFirst.mockResolvedValue(ws);
  mockLoad.mockResolvedValue({ missions: [{ id: 'm1', title: 'M', status: 'active', phase: 'needs_you', awaitingHuman: 2 }], more: false });
});

describe('GET /api/workspaces/[id]/visual-review', () => {
  it('401s with no session and no key', async () => {
    expect((await call()).status).toBe(401);
  });

  it('403s a non-admin key, like the mission read', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'worker' });
    expect((await call(WS, 'bld_x')).status).toBe(403);
  });

  it('404s a non-UUID id without a query', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    expect((await call('abc')).status).toBe(404);
    expect(mockWorkspaceFindFirst).not.toHaveBeenCalled();
  });

  it('returns the awaiting missions for a member, scoped to the caller teams', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockResolveTeamIds.mockResolvedValue(['team-a']);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspace).toEqual({ id: WS, name: 'Example' });
    expect(body.missions[0]).toMatchObject({ id: 'm1', awaitingHuman: 2 });
    expect(body.more).toBe(false);
    expect(mockLoad).toHaveBeenCalledWith(WS, ['team-a']);
    const q = new PgDialect().sqlToQuery(mockWorkspaceFindFirst.mock.calls[0][0].where);
    expect(q.sql).toBe('"workspaces"."id" = $1');
    expect(q.params).toEqual([WS]);
  });

  it('404s a workspace of another team, and never loads', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockResolveTeamIds.mockResolvedValue(['team-b']);
    expect((await call()).status).toBe(404);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('404s a session that cannot reach the workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockResolveTeamIds.mockResolvedValue(['team-a']);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('checks an admin key through account workspace access', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'admin' });
    mockResolveTeamIds.mockResolvedValue(['team-a']);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    expect((await call(WS, 'bld_x')).status).toBe(200);
    expect(mockVerifyAccountWorkspaceAccess).toHaveBeenCalledWith('acct-1', WS);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    expect((await call(WS, 'bld_x')).status).toBe(404);
  });
});

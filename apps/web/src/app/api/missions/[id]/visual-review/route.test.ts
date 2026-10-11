/**
 * GET /api/missions/[id]/visual-review (docs/design/visual-qa-human-review.md,
 * "Read"). Illustrative ids only.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildVisualReviewFixtureModel } from '@/lib/visual-review-model.fixtures';

const mockGetCurrentUser = mock(async () => null as any);
const mockAuthenticateApiKey = mock(async () => null as any);
const mockResolveTeamIds = mock(async () => [] as string[]);
const mockVerifyAccountWorkspaceAccess = mock(async () => false);
const mockVerifyWorkspaceAccess = mock(async () => ({ teamId: 'team-a', role: 'member' }) as any);
const mockMissionFindFirst = mock(async (_q: any) => null as any);
const mockLoadVisualReview = mock(async (_m: any) => buildVisualReviewFixtureModel('needs_you'));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  resolveAccountTeamIds: mockResolveTeamIds,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));
mock.module('@buildd/core/db', () => ({ db: { query: { missions: { findFirst: mockMissionFindFirst } } } }));
mock.module('@/lib/visual-review-load', () => ({ loadVisualReview: mockLoadVisualReview }));

const { GET } = await import('./route');

const MISSION = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const mission = { id: MISSION, teamId: 'team-a', workspaceId: WS };

const call = (id = MISSION, key?: string) =>
  GET(new NextRequest(`http://localhost/api/missions/${id}/visual-review`, { headers: key ? { authorization: `Bearer ${key}` } : {} }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  for (const m of [mockGetCurrentUser, mockAuthenticateApiKey, mockResolveTeamIds, mockVerifyAccountWorkspaceAccess, mockVerifyWorkspaceAccess, mockMissionFindFirst, mockLoadVisualReview]) m.mockClear();
  mockGetCurrentUser.mockResolvedValue(null);
  mockAuthenticateApiKey.mockResolvedValue(null);
  mockResolveTeamIds.mockResolvedValue([]);
  mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
  mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-a', role: 'member' });
  mockMissionFindFirst.mockResolvedValue(mission);
  mockLoadVisualReview.mockResolvedValue(buildVisualReviewFixtureModel('needs_you'));
});

describe('GET /api/missions/[id]/visual-review', () => {
  it('401s with neither a session nor a key', async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(mockMissionFindFirst).not.toHaveBeenCalled();
  });

  it('404s a non-UUID id without a query', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    expect((await call('abc12345')).status).toBe(404);
    expect(mockMissionFindFirst).not.toHaveBeenCalled();
  });

  it('returns the model for a signed-in member of the mission team, looking the mission up by id', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockResolveTeamIds.mockResolvedValue(['team-a']);
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json();
    expect(body.model.missionId).toBe('fixture-mission');
    expect(body.model.phase).toBe('needs_you');
    expect(Array.isArray(body.model.cells)).toBe(true);
    expect(body.model.cells[0]).toHaveProperty('history');
    expect(body.model.summary).toHaveProperty('awaitingHuman');
    expect(body.model.fixTasks[0]).toMatchObject({ status: expect.any(String), prUrl: expect.anything() });
    expect(body.model.fixTasks[0]).toHaveProperty('mergedAt');
    expect(mockLoadVisualReview).toHaveBeenCalledWith({ id: MISSION, workspaceId: WS });

    const where = mockMissionFindFirst.mock.calls[0][0].where;
    const q = new PgDialect().sqlToQuery(where);
    expect(q.sql).toBe('"missions"."id" = $1');
    expect(q.params).toEqual([MISSION]);
  });

  it('404s a mission of another team, and never loads its shots', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockResolveTeamIds.mockResolvedValue(['team-b']);
    const res = await call();
    expect(res.status).toBe(404);
    expect(mockLoadVisualReview).not.toHaveBeenCalled();
  });

  it('404s a session that cannot reach the mission workspace, and never loads its shots', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockResolveTeamIds.mockResolvedValue(['team-a']);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-1', WS);
    expect(mockLoadVisualReview).not.toHaveBeenCalled();
  });

  it('404s a mission that does not exist', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockResolveTeamIds.mockResolvedValue(['team-a']);
    mockMissionFindFirst.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it('403s a non-admin key', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-a', level: 'worker' });
    expect((await call(MISSION, 'bld_x')).status).toBe(403);
  });

  it('accepts an admin key of the mission team that reaches the workspace', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-a', level: 'admin' });
    mockResolveTeamIds.mockResolvedValue(['team-a']);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    expect((await call(MISSION, 'bld_x')).status).toBe(200);
    expect(mockVerifyAccountWorkspaceAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'acct-1' }), WS);

    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    expect((await call(MISSION, 'bld_x')).status).toBe(404);
  });

  it('404s an admin key of another team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-b', level: 'admin' });
    mockResolveTeamIds.mockResolvedValue(['team-b']);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    expect((await call(MISSION, 'bld_x')).status).toBe(404);
    expect(mockLoadVisualReview).not.toHaveBeenCalled();
  });
});

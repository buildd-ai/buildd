import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockMissionsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockReconcile = mock(() =>
  Promise.resolve({ checked: 0, fixes: [] as any[], unverified: [] as any[] }),
);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: mockResolveAccountTeamIds }));
mock.module('@/lib/pr-fact-import', () => ({ importMissionPrFacts: mockReconcile }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
  },
}));

import { POST } from './route';

function callHandler(url = 'http://localhost:3000/api/missions/ffffffff-ffff-4fff-8fff-ffffffffffff/reconcile', id = 'ffffffff-ffff-4fff-8fff-ffffffffffff') {
  return POST(new NextRequest(url, { method: 'POST' }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockAuthenticateApiKey.mockReset();
  mockAuthenticateApiKey.mockResolvedValue(null);
  mockResolveAccountTeamIds.mockReset();
  mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
  mockMissionsFindFirst.mockReset();
  mockWorkspacesFindFirst.mockReset();
  mockWorkspacesFindFirst.mockResolvedValue(null);
  mockReconcile.mockReset();
  mockReconcile.mockResolvedValue({ checked: 0, fixes: [], unverified: [] });
});

describe('POST /api/missions/[id]/reconcile', () => {
  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await callHandler()).status).toBe(401);
  });

  it('404s a non-UUID id (e.g. a short 8-hex id) without querying the db', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    const url = 'http://localhost:3000/api/missions/a1b2c3d4/reconcile';
    const res = await callHandler(url, 'a1b2c3d4');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('UUID');
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
  });

  it('returns 404 when the mission is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockMissionsFindFirst.mockResolvedValue(null);
    expect((await callHandler()).status).toBe(404);
  });

  it('returns 404 for a mission on another team with a non-open workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', teamId: 'team-other', workspaceId: 'ws1' });
    mockWorkspacesFindFirst.mockResolvedValue({ accessMode: 'restricted' });
    expect((await callHandler()).status).toBe(404);
  });

  it('reports the corrections it made', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', teamId: 'team-1', workspaceId: 'ws1' });
    mockReconcile.mockResolvedValue({
      checked: 3,
      fixes: [
        {
          workerId: 'w1',
          prUrl: 'https://github.com/maxjacu/sibling-app/pull/146',
          prNumber: 146,
          before: { mergedAt: null, prLifecycleStatus: null },
          after: { mergedAt: '2026-08-21T18:56:20Z', prLifecycleStatus: 'merged' },
        },
      ],
      unverified: [],
    });

    const res = await callHandler();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.checked).toBe(3);
    expect(data.corrected).toBe(1);
    expect(data.fixes[0].after.prLifecycleStatus).toBe('merged');
    expect(data.dryRun).toBe(false);
  });

  it('honours ?dryRun=true', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', teamId: 'team-1', workspaceId: 'ws1' });

    const res = await callHandler('http://localhost:3000/api/missions/ffffffff-ffff-4fff-8fff-ffffffffffff/reconcile?dryRun=true');
    expect(res.status).toBe(200);
    expect((await res.json()).dryRun).toBe(true);
    expect(mockReconcile).toHaveBeenCalledWith('ffffffff-ffff-4fff-8fff-ffffffffffff', { dryRun: true });
  });
});

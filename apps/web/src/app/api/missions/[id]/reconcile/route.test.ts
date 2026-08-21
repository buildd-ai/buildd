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
mock.module('@/lib/pr-state-reconcile', () => ({ reconcileMissionPrState: mockReconcile }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
  },
}));

import { POST } from './route';

function callHandler(url = 'http://localhost:3000/api/missions/m1/reconcile') {
  return POST(new NextRequest(url, { method: 'POST' }), { params: Promise.resolve({ id: 'm1' }) });
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

  it('returns 404 when the mission is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockMissionsFindFirst.mockResolvedValue(null);
    expect((await callHandler()).status).toBe(404);
  });

  it('returns 404 for a mission on another team with a non-open workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'm1', teamId: 'team-other', workspaceId: 'ws1' });
    mockWorkspacesFindFirst.mockResolvedValue({ accessMode: 'restricted' });
    expect((await callHandler()).status).toBe(404);
  });

  it('reports the corrections it made', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'm1', teamId: 'team-1', workspaceId: 'ws1' });
    mockReconcile.mockResolvedValue({
      checked: 3,
      fixes: [
        {
          workerId: 'w1',
          prUrl: 'https://github.com/maxjacu/moa-ops/pull/146',
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
    mockMissionsFindFirst.mockResolvedValue({ id: 'm1', teamId: 'team-1', workspaceId: 'ws1' });

    const res = await callHandler('http://localhost:3000/api/missions/m1/reconcile?dryRun=true');
    expect(res.status).toBe(200);
    expect((await res.json()).dryRun).toBe(true);
    expect(mockReconcile).toHaveBeenCalledWith('m1', { dryRun: true });
  });
});

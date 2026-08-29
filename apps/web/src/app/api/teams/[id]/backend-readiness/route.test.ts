import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let currentUser: { id: string } | null = { id: 'user-1' };
const mockGetUserFromRequest = mock(() => Promise.resolve(currentUser));
mock.module('@/lib/auth-helpers', () => ({ getUserFromRequest: mockGetUserFromRequest }));

let userTeamIds: string[] = ['team-1'];
let teamWorkspaceIds: string[] = ['ws-1'];
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mock(() => Promise.resolve(userTeamIds)),
  getTeamWorkspaceIds: mock(() => Promise.resolve(teamWorkspaceIds)),
}));

let summary: any = { backends: [], totalStranded: 0 };
let summaryError: Error | null = null;
const mockGetBackendStrandSummary = mock((_opts: any) =>
  summaryError ? Promise.reject(summaryError) : Promise.resolve(summary),
);
mock.module('@/lib/backend-strand', () => ({
  getBackendStrandSummary: mockGetBackendStrandSummary,
}));

const { GET } = await import('./route');

const call = (teamId = 'team-1') =>
  GET(new NextRequest(`http://localhost/api/teams/${teamId}/backend-readiness`), {
    params: Promise.resolve({ id: teamId }),
  });

beforeEach(() => {
  currentUser = { id: 'user-1' };
  userTeamIds = ['team-1'];
  teamWorkspaceIds = ['ws-1'];
  summaryError = null;
  summary = {
    backends: [
      { backend: 'claude', label: 'Claude', configured: true, enabledForTeam: true, receivesMaskedWork: false, strandedPending: 0, sampleTasks: [] },
      { backend: 'codex', label: 'Codex', configured: false, enabledForTeam: true, receivesMaskedWork: false, strandedPending: 4, sampleTasks: [{ id: 't-1', title: 'A', workspaceName: 'alpha' }] },
    ],
    totalStranded: 4,
  };
  mockGetBackendStrandSummary.mockClear();
});

describe('GET /api/teams/[id]/backend-readiness', () => {
  it('returns per-backend stranding for a team the caller belongs to', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalStranded).toBe(4);
    expect(body.backends.find((b: any) => b.backend === 'codex')).toMatchObject({
      configured: false,
      strandedPending: 4,
    });
    expect(mockGetBackendStrandSummary).toHaveBeenCalledWith({
      teamId: 'team-1',
      workspaceIds: ['ws-1'],
    });
  });

  it('rejects an unauthenticated caller', async () => {
    currentUser = null;
    expect((await call()).status).toBe(401);
  });

  it('hides a team the caller does not belong to', async () => {
    userTeamIds = ['other-team'];
    const res = await call();
    expect(res.status).toBe(404);
    expect(mockGetBackendStrandSummary).not.toHaveBeenCalled();
  });

  it('does not fail the settings page when the rollup errors', async () => {
    summaryError = new Error('db down');
    const res = await call();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBeTruthy();
  });
});

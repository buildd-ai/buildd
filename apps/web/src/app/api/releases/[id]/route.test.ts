import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * GET /api/releases/[id] — backs the dashboard release detail page and the
 * `get_release` MCP action (via handleBuilddAction's `api()` self-call).
 *
 * Regression: apiAccount (API key / OAuth JWT) callers used to skip the
 * team-ownership check entirely — only `user` sessions were checked — so any
 * authenticated API key could fetch a release belonging to another team.
 */

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_TEAM = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const RELEASE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));
const mockGithubReposFindFirst = mock(() => Promise.resolve(null as any));
const mockGetReleaseWithTaskEdges = mock(() => Promise.resolve(null as any));
const mockDbSelect = mock(() => ({
  from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
    select: mockDbSelect,
  },
}));

mock.module('@/lib/release-queries', () => ({
  getReleaseWithTaskEdges: mockGetReleaseWithTaskEdges,
}));

import { GET } from './route';

function makeRequest(apiKey = 'bld_test') {
  return new NextRequest(`http://localhost/api/releases/${RELEASE_ID}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
}

function call(apiKey = 'bld_test') {
  return GET(makeRequest(apiKey), { params: Promise.resolve({ id: RELEASE_ID }) });
}

beforeEach(() => {
  mockGetCurrentUser.mockReset().mockResolvedValue(null);
  mockAuthenticateApiKey.mockReset().mockResolvedValue({ id: 'acc-1', level: 'worker', teamId: TEAM_ID, authType: 'api' });
  mockGetUserTeamIds.mockReset().mockResolvedValue([]);
  mockWorkspacesFindFirst.mockReset().mockResolvedValue({ id: WORKSPACE_ID, name: 'ws', teamId: TEAM_ID, githubRepoId: null });
  mockGithubReposFindFirst.mockReset().mockResolvedValue(null);
  mockGetReleaseWithTaskEdges.mockReset().mockResolvedValue({
    release: { id: RELEASE_ID, workspaceId: WORKSPACE_ID, headSha: 'abc', previousSha: 'def' },
    edges: [],
  });
  mockDbSelect.mockReset().mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
  });
});

describe('GET /api/releases/[id]', () => {
  it('401s with no credentials', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await call('');
    expect(res.status).toBe(401);
  });

  it('404s when the release does not exist', async () => {
    mockGetReleaseWithTaskEdges.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
  });

  it('403s when an API key belongs to a different team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-2', level: 'worker', teamId: OTHER_TEAM, authType: 'api' });
    const res = await call();
    expect(res.status).toBe(403);
  });

  it('403s when a user session belongs to a different team', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue([OTHER_TEAM]);
    const res = await call();
    expect(res.status).toBe(403);
  });

  it('returns the release with attributed tasks for a same-team API key', async () => {
    mockGetReleaseWithTaskEdges.mockResolvedValue({
      release: { id: RELEASE_ID, workspaceId: WORKSPACE_ID, headSha: 'abc', previousSha: 'def' },
      edges: [{ taskId: 't-1', prNumber: 42, commitSha: 'abc', taskTitle: 'Fix it', taskStatus: 'completed', missionId: null }],
    });
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(RELEASE_ID);
    expect(body.attributedTasks).toHaveLength(1);
    expect(body.attributedTasks[0].prNumber).toBe(42);
  });
});

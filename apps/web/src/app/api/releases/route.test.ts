import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * GET /api/releases — backs the `list_releases` MCP action for every
 * transport (API-key /api/mcp, OAuth /api/mcp-oauth, and the in-process
 * runner server), all of which reach this route through handleBuilddAction's
 * `api()` self-call. See packages/core/mcp-tools.ts.
 */

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_TEAM = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const RELEASE_ID_1 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));
const mockListReleasesQuery = mock(() => Promise.resolve([] as any[]));

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
    },
  },
}));

mock.module('@/lib/release-queries', () => ({
  listReleasesQuery: mockListReleasesQuery,
}));

import { GET } from './route';

function makeRequest(qs: string, apiKey = 'bld_test') {
  return new NextRequest(`http://localhost/api/releases${qs}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
}

beforeEach(() => {
  mockGetCurrentUser.mockReset().mockResolvedValue(null);
  mockAuthenticateApiKey.mockReset().mockResolvedValue({ id: 'acc-1', level: 'worker', teamId: TEAM_ID, authType: 'api' });
  mockGetUserTeamIds.mockReset().mockResolvedValue([]);
  mockWorkspacesFindFirst.mockReset().mockResolvedValue({ teamId: TEAM_ID });
  mockListReleasesQuery.mockReset().mockResolvedValue([]);
});

describe('GET /api/releases', () => {
  it('401s with no credentials', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await GET(makeRequest(`?workspaceId=${WORKSPACE_ID}`, ''));
    expect(res.status).toBe(401);
  });

  it('400s when workspaceId is missing', async () => {
    const res = await GET(makeRequest(''));
    expect(res.status).toBe(400);
  });

  it('404s when the workspace does not exist', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(null);
    const res = await GET(makeRequest(`?workspaceId=${WORKSPACE_ID}`));
    expect(res.status).toBe(404);
  });

  it('403s when the API key belongs to a different team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-2', level: 'worker', teamId: OTHER_TEAM, authType: 'api' });
    const res = await GET(makeRequest(`?workspaceId=${WORKSPACE_ID}`));
    expect(res.status).toBe(403);
  });

  it('returns releases for a same-team API key', async () => {
    mockListReleasesQuery.mockResolvedValue([{ id: RELEASE_ID_1 }]);
    const res = await GET(makeRequest(`?workspaceId=${WORKSPACE_ID}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.releases).toEqual([{ id: RELEASE_ID_1 }]);
    expect(mockListReleasesQuery).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      missionId: undefined,
      state: undefined,
      limit: undefined,
    });
  });

  it('forwards state/missionId/limit filters', async () => {
    await GET(makeRequest(`?workspaceId=${WORKSPACE_ID}&state=healthy&missionId=m-1&limit=5`));
    expect(mockListReleasesQuery).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      missionId: 'm-1',
      state: 'healthy',
      limit: 5,
    });
  });
});

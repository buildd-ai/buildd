/**
 * Regression tests for the team artifact list.
 *
 * `shareUrl` used to be derived from the presence of a `shareToken` alone, so a
 * PRIVATE artifact (or one whose share had been revoked and re-minted) was
 * listed with a live-looking /share/<token> link. The link is only real while
 * `visibility === 'public'`.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/app/api/artifacts/route.test.ts
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => [] as any);
const mockMissionsFindMany = mock(() => [] as any);
const mockArtifactsFindMany = mock(() => [] as any);

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
      teamMembers: { findFirst: mock(() => null) },
      missions: { findMany: mockMissionsFindMany },
      artifacts: { findMany: mockArtifactsFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  inArray: (field: any, values: any) => ({ field, values, type: 'inArray' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  artifacts: { missionId: 'missionId', type: 'type', createdAt: 'createdAt' },
  missions: { teamId: 'teamId' },
  teamMembers: { teamId: 'teamId', role: 'role' },
}));

const { GET } = await import('./route');

function req(): NextRequest {
  return new NextRequest('http://localhost:3000/api/artifacts', { method: 'GET' });
}

describe('GET /api/artifacts', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockMissionsFindMany.mockReset();
    mockArtifactsFindMany.mockReset();

    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindMany.mockResolvedValue([{ id: 'mission-1' }]);
  });

  it('returns 401 when there is no caller', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('omits shareUrl for a private artifact that still carries a token', async () => {
    mockArtifactsFindMany.mockResolvedValue([
      {
        id: 'artifact-private',
        shareToken: 'leftover-token',
        visibility: 'private',
        mission: { id: 'mission-1', title: 'Mission One' },
      },
    ]);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifacts[0].shareUrl).toBeNull();
  });

  it('returns a shareUrl for a public artifact', async () => {
    mockArtifactsFindMany.mockResolvedValue([
      {
        id: 'artifact-public',
        shareToken: 'live-token',
        visibility: 'public',
        mission: { id: 'mission-1', title: 'Mission One' },
      },
    ]);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifacts[0].shareUrl).toContain('/share/live-token');
    expect(data.artifacts[0].missionTitle).toBe('Mission One');
  });
});

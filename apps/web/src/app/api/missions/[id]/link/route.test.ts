import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockMissionsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockSecretsFindFirst = mock(() => null as any);
const mockMissionsUpdateSet = mock((_v: any) => ({ where: async () => {} }));

// We do NOT mock '@buildd/core/external-links' — bun's mock.module is global and
// persistent (keyed by resolved path), so stubbing it here would leak into
// packages/core's own external-links test and break it. Instead we let the REAL
// linkExternal run against an insert-capable mock db and record what it upserts.
const mockInsertValues: any[] = [];
const mockInsert = mock((_table: any) => ({
  values: (v: any) => {
    mockInsertValues.push(v);
    return {
      onConflictDoUpdate: (_cfg: any) => ({
        returning: async () => [{ id: 'link-1', createdAt: new Date(), updatedAt: new Date(), ...v }],
      }),
    };
  },
}));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: mockResolveAccountTeamIds }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      secrets: { findFirst: mockSecretsFindFirst },
    },
    insert: mockInsert,
    update: () => ({ set: mockMissionsUpdateSet }),
  },
}));

// NOTE: we deliberately do NOT mock 'drizzle-orm' or '@buildd/core/db/schema'.
// bun's mock.module is global + persistent (keyed by resolved path); stubbing those
// shared modules here leaks into packages/core's external-links test, which relies on
// the REAL drizzle expressions + schema. The real ones are harmless here — the mock db
// ignores the query ASTs they build.

import { POST } from './route';

const PARAMS = Promise.resolve({ id: 'mission-1' });
const MISSION = { id: 'mission-1', teamId: 'team-1', workspaceId: 'ws-1' };
const LINEAR_CONFIG = { provider: 'linear' as const, connectorId: 'conn-1' };
const PROJECT_URL = 'https://linear.app/acme/project/mobile-app-9f8e7d6c';

function makeReq(body?: any, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/missions/mission-1/link', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('POST /api/missions/[id]/link', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockMissionsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockSecretsFindFirst.mockReset();
    mockMissionsUpdateSet.mockReset();
    mockInsert.mockClear();
    mockInsertValues.length = 0;

    mockAuthenticateApiKey.mockResolvedValue(null);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue(MISSION);
    mockWorkspacesFindFirst.mockResolvedValue({ workTrackerConfig: LINEAR_CONFIG });
    mockSecretsFindFirst.mockResolvedValue(null); // no token → validation skipped
    mockMissionsUpdateSet.mockReturnValue({ where: async () => {} });
  });
  afterAll(() => {});

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(makeReq({ url: PROJECT_URL }), { params: PARAMS });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the mission is not found / not accessible', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockMissionsFindFirst.mockResolvedValue(null);
    const res = await POST(makeReq({ url: PROJECT_URL }), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  it('returns 400 when the workspace has no Linear connector', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ workTrackerConfig: { provider: 'github' } });
    const res = await POST(makeReq({ url: PROJECT_URL }), { params: PARAMS });
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 400 when the url is missing or unparseable', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const missing = await POST(makeReq({}), { params: PARAMS });
    expect(missing.status).toBe(400);
    const junk = await POST(makeReq({ url: 'https://github.com/a/b/issues/1' }), { params: PARAMS });
    expect(junk.status).toBe(400);
  });

  it('upserts the external link with the right fields and dual-writes the mission columns', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makeReq({ url: PROJECT_URL }), { params: PARAMS });
    expect(res.status).toBe(200);

    // Link row upserted with the parsed, deterministic external id.
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const input = mockInsertValues[0];
    expect(input).toMatchObject({
      teamId: 'team-1',
      provider: 'linear',
      builddEntityType: 'mission',
      builddEntityId: 'mission-1',
      externalId: 'mobile-app-9f8e7d6c',
      externalUrl: PROJECT_URL,
    });

    // Mission columns dual-written.
    expect(mockMissionsUpdateSet).toHaveBeenCalledTimes(1);
    const setArg = mockMissionsUpdateSet.mock.calls[0][0];
    expect(setArg.externalIssueId).toBe('mobile-app-9f8e7d6c');
    expect(setArg.externalIssueUrl).toBe(PROJECT_URL);

    const data = await res.json();
    expect(data.externalId).toBe('mobile-app-9f8e7d6c');
  });

  it('is idempotent — re-linking the same URL yields the same external id', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    await POST(makeReq({ url: PROJECT_URL }), { params: PARAMS });
    await POST(makeReq({ url: PROJECT_URL }), { params: PARAMS });
    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(mockInsertValues[0].externalId).toBe(mockInsertValues[1].externalId);
  });

  it('works with an admin API key (403 for non-admin)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'worker' });
    const forbidden = await POST(makeReq({ url: PROJECT_URL }, { authorization: 'Bearer bld_key' }), { params: PARAMS });
    expect(forbidden.status).toBe(403);

    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    const ok = await POST(makeReq({ url: PROJECT_URL }, { authorization: 'Bearer bld_key' }), { params: PARAMS });
    expect(ok.status).toBe(200);
  });
});

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const VICTIM_WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VICTIM_TEAM_ID = 'team-victim';
const CALLER_TEAM_ID = 'team-caller';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([CALLER_TEAM_ID]));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));

const mockWorkspacesFindFirst = mock(() => Promise.resolve({ teamId: VICTIM_TEAM_ID } as any));
const mockRegistryFindFirst = mock(() => Promise.resolve(null as any));

const mockInsertValues = mock(() => Promise.resolve([]));
const mockInsert = mock(() => ({ values: mockInsertValues }));
const mockUpdateWhere = mock(() => Promise.resolve([]));
const mockUpdate = mock(() => ({ set: mock(() => ({ where: mockUpdateWhere })) }));
const mockDeleteWhere = mock(() => Promise.resolve([]));
const mockDelete = mock(() => ({ where: mockDeleteWhere }));

const mockResolveAllTiers = mock(() => Promise.resolve({ premium: { model: 'm' } } as any));
const mockInvalidateTierCache = mock(() => {});

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      modelTierRegistry: { findFirst: mockRegistryFindFirst },
    },
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
}));

mock.module('@buildd/core/model-tier-registry', () => ({
  resolveAllTiers: mockResolveAllTiers,
  invalidateTierCache: mockInvalidateTierCache,
}));

import { GET, POST, DELETE } from './route';

function getRequest(workspaceId?: string, apiKey?: string) {
  const url = workspaceId
    ? `http://localhost/api/model-tiers?workspaceId=${workspaceId}`
    : 'http://localhost/api/model-tiers';
  return new NextRequest(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
}

function postRequest(body: unknown, apiKey?: string) {
  return new NextRequest('http://localhost/api/model-tiers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function deleteRequest(tier: string, workspaceId?: string, apiKey?: string) {
  const qs = new URLSearchParams({ tier, ...(workspaceId ? { workspaceId } : {}) });
  return new NextRequest(`http://localhost/api/model-tiers?${qs}`, {
    method: 'DELETE',
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
}

const VALID_BODY = {
  tier: 'premium',
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  workspaceId: VICTIM_WORKSPACE_ID,
};

describe('/api/model-tiers workspace scoping', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockRegistryFindFirst.mockReset();
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockUpdate.mockClear();
    mockDelete.mockClear();
    mockResolveAllTiers.mockClear();
    mockInvalidateTierCache.mockClear();

    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetUserTeamIds.mockResolvedValue([CALLER_TEAM_ID]);
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: VICTIM_TEAM_ID });
    mockRegistryFindFirst.mockResolvedValue(null);
    mockResolveAllTiers.mockResolvedValue({ premium: { model: 'm' } });
  });

  // ── GET ────────────────────────────────────────────────────────────────────

  it('GET rejects a session user who is not a member of the workspace team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-outsider' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const res = await GET(getRequest(VICTIM_WORKSPACE_ID));

    expect(res.status).toBe(404);
    expect(mockResolveAllTiers).not.toHaveBeenCalled();
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-outsider', VICTIM_WORKSPACE_ID);
  });

  it('GET rejects an admin API key whose account cannot reach the workspace', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-attacker', level: 'admin', teamId: CALLER_TEAM_ID });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);

    const res = await GET(getRequest(VICTIM_WORKSPACE_ID, 'bld_attacker'));

    expect(res.status).toBe(404);
    expect(mockResolveAllTiers).not.toHaveBeenCalled();
  });

  it('GET resolves tiers for a member of the workspace team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-member' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: VICTIM_TEAM_ID, role: 'member' });

    const res = await GET(getRequest(VICTIM_WORKSPACE_ID));

    expect(res.status).toBe(200);
    expect(mockResolveAllTiers).toHaveBeenCalledWith(VICTIM_TEAM_ID, VICTIM_WORKSPACE_ID);
  });

  // ── POST ───────────────────────────────────────────────────────────────────

  it('POST rejects a session user who is not a member of the workspace team and writes nothing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-outsider' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInvalidateTierCache).not.toHaveBeenCalled();
  });

  it('POST rejects an admin API key whose account cannot reach the workspace and writes nothing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-attacker', level: 'admin', teamId: CALLER_TEAM_ID });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);

    const res = await POST(postRequest(VALID_BODY, 'bld_attacker'));

    expect(res.status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInvalidateTierCache).not.toHaveBeenCalled();
  });

  it('POST upserts for a member of the workspace team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-member' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: VICTIM_TEAM_ID, role: 'admin' });

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: VICTIM_TEAM_ID, workspaceId: VICTIM_WORKSPACE_ID }),
    );
    expect(mockInvalidateTierCache).toHaveBeenCalledWith(VICTIM_TEAM_ID, VICTIM_WORKSPACE_ID);
  });

  // ── DELETE ─────────────────────────────────────────────────────────────────

  it('DELETE rejects a session user who is not a member of the workspace team and deletes nothing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-outsider' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const res = await DELETE(deleteRequest('premium', VICTIM_WORKSPACE_ID));

    expect(res.status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockInvalidateTierCache).not.toHaveBeenCalled();
  });

  it('DELETE rejects an admin API key whose account cannot reach the workspace and deletes nothing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-attacker', level: 'admin', teamId: CALLER_TEAM_ID });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);

    const res = await DELETE(deleteRequest('premium', VICTIM_WORKSPACE_ID, 'bld_attacker'));

    expect(res.status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockInvalidateTierCache).not.toHaveBeenCalled();
  });

  it('DELETE removes the row for a member of the workspace team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-member' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: VICTIM_TEAM_ID, role: 'admin' });

    const res = await DELETE(deleteRequest('premium', VICTIM_WORKSPACE_ID));

    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockInvalidateTierCache).toHaveBeenCalledWith(VICTIM_TEAM_ID, VICTIM_WORKSPACE_ID);
  });

  // ── Unauthenticated ────────────────────────────────────────────────────────

  it('GET returns 401 with no auth at all', async () => {
    const res = await GET(getRequest(VICTIM_WORKSPACE_ID));
    expect(res.status).toBe(401);
  });
});

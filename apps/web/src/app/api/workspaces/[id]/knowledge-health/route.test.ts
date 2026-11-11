import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(false as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false as any));
const mockGetKnowledgeHealth = mock(() => Promise.resolve({} as any));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

// Mock the knowledge-store barrel so the route's DB aggregation is controllable
// and never touches a real Postgres connection.
const mockGetWorkspaceVoyageBudget = mock(async () => null as unknown);
mock.module('@buildd/core/knowledge-store', () => ({
  getKnowledgeHealth: mockGetKnowledgeHealth,
  getWorkspaceVoyageBudget: mockGetWorkspaceVoyageBudget,
}));

const mockGetIngestSwitchHealth = mock(async () => ({ enabled: true, skippedJobs: 0 }) as any);
mock.module('@/lib/knowledge-ingest-switch', () => ({ getIngestSwitchHealth: mockGetIngestSwitchHealth }));

const originalNodeEnv = process.env.NODE_ENV;

import { GET } from './route';

const mockParams = Promise.resolve({ id: 'ws-1' });

function createMockRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/workspaces/ws-1/knowledge-health', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

const SAMPLE_HEALTH = {
  workspaceId: 'ws-1',
  corpora: [{ corpus: 'code', currentChunks: 42 }],
  totalCurrentChunks: 42,
  lastIngestByRepo: [],
  pendingEntityRefs: 0,
  hasCodeIndex: true,
  lastSuccessfulIngestAt: null,
  staleAfterDays: 14,
  freshness: 'stale',
};

describe('GET /api/workspaces/[id]/knowledge-health: Voyage budget notice', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1' });
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockGetKnowledgeHealth.mockReset();
    mockGetKnowledgeHealth.mockResolvedValue(SAMPLE_HEALTH);
    mockGetWorkspaceVoyageBudget.mockReset();
  });

  it('returns where the team stands beside the health', async () => {
    const status = { enforced: true, state: 'over', message: 'used its budget' };
    mockGetWorkspaceVoyageBudget.mockResolvedValue(status);
    const res = await GET(createMockRequest({ authorization: 'Bearer bld_x' }), { params: mockParams });
    expect((await res.json()).voyageBudget).toEqual(status);
  });

  it('still serves the health when the budget cannot be read', async () => {
    mockGetWorkspaceVoyageBudget.mockRejectedValue(new Error('db down'));
    const res = await GET(createMockRequest({ authorization: 'Bearer bld_x' }), { params: mockParams });
    expect(res.status).toBe(200);
    expect((await res.json()).voyageBudget).toBeNull();
  });
});

describe('GET /api/workspaces/[id]/knowledge-health', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockGetKnowledgeHealth.mockReset();
    mockGetKnowledgeHealth.mockResolvedValue(SAMPLE_HEALTH);
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const res = await GET(createMockRequest(), { params: mockParams });
    expect(res.status).toBe(401);
    expect(mockGetKnowledgeHealth).not.toHaveBeenCalled();
  });

  it('returns 404 when session user lacks workspace access', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const res = await GET(createMockRequest(), { params: mockParams });
    expect(res.status).toBe(404);
    expect(mockGetKnowledgeHealth).not.toHaveBeenCalled();
  });

  it('returns the health payload for an authenticated workspace member', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const res = await GET(createMockRequest(), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.health).toEqual(SAMPLE_HEALTH);
    expect(mockGetKnowledgeHealth).toHaveBeenCalledWith('ws-1');
  });

  it('allows API key auth when the account belongs to the workspace team', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', type: 'service' });

    const res = await GET(createMockRequest({ authorization: 'Bearer bld_testkey123' }), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.health.workspaceId).toBe('ws-1');
  });

  it('returns 404 when API key account lacks workspace access', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', type: 'service' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);

    const res = await GET(createMockRequest({ authorization: 'Bearer bld_testkey123' }), { params: mockParams });
    expect(res.status).toBe(404);
    expect(mockGetKnowledgeHealth).not.toHaveBeenCalled();
  });

  it('returns 500 when aggregation throws', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetKnowledgeHealth.mockRejectedValue(new Error('db down'));

    const res = await GET(createMockRequest(), { params: mockParams });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/workspaces/[id]/knowledge-health: ingest switch', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1' });
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockGetKnowledgeHealth.mockReset();
    mockGetKnowledgeHealth.mockResolvedValue(SAMPLE_HEALTH);
    mockGetWorkspaceVoyageBudget.mockReset();
    mockGetWorkspaceVoyageBudget.mockResolvedValue(null);
    mockGetIngestSwitchHealth.mockReset();
  });

  it('reports the switch and the count of skipped jobs beside the health', async () => {
    mockGetIngestSwitchHealth.mockResolvedValue({ enabled: false, skippedJobs: 3 });
    const res = await GET(createMockRequest({ authorization: 'Bearer bld_x' }), { params: mockParams });
    const data = await res.json();
    expect(data.ingest).toEqual({ enabled: false, skippedJobs: 3 });
    expect(data.health.workspaceId).toBe('ws-1');
  });

  it('still serves the health when the switch cannot be read', async () => {
    mockGetIngestSwitchHealth.mockRejectedValue(new Error('db down'));
    const res = await GET(createMockRequest({ authorization: 'Bearer bld_x' }), { params: mockParams });
    expect(res.status).toBe(200);
    expect((await res.json()).ingest).toBeNull();
  });
});

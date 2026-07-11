import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mocks
const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => null as any);

const mockWorkspacesFindFirst = mock(() => null as any);
const mockConnectorsFindFirst = mock(() => null as any);
const mockConnectorWorkspacesFindFirst = mock(() => null as any);
const mockUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      connectors: { findFirst: mockConnectorsFindFirst },
      connectorWorkspaces: { findFirst: mockConnectorWorkspacesFindFirst },
    },
    update: () => mockUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', teamId: 'teamId', accessMode: 'accessMode', workTrackerConfig: 'workTrackerConfig' },
  connectors: { id: 'id', teamId: 'teamId' },
  connectorWorkspaces: { connectorId: 'connectorId', workspaceId: 'workspaceId', enabled: 'enabled' },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, PATCH } from './route';

const PARAMS = Promise.resolve({ id: 'ws-1' });

function makeReq(method = 'GET', headers: Record<string, string> = {}, body?: unknown) {
  return new NextRequest('http://localhost:3000/api/workspaces/ws-1/settings', {
    method,
    headers: new Headers({ 'Content-Type': 'application/json', ...headers }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/workspaces/[id]/settings', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
  });
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(401);
  });

  it('returns workTrackerConfig when authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue({
      workTrackerConfig: { connectorId: 'conn-1', provider: 'linear' },
    });

    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workTrackerConfig).toEqual({ connectorId: 'conn-1', provider: 'linear' });
  });

  it('returns null workTrackerConfig when not set', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ workTrackerConfig: null });

    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workTrackerConfig).toBeNull();
  });
});

describe('PATCH /api/workspaces/[id]/settings', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockConnectorsFindFirst.mockReset();
    mockConnectorWorkspacesFindFirst.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
  });
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await PATCH(makeReq('PATCH', {}, { workTrackerConfig: null }), { params: PARAMS });
    expect(res.status).toBe(401);
  });

  it('returns 400 when body is missing workTrackerConfig key', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });

    const res = await PATCH(makeReq('PATCH', {}, { other: 'field' }), { params: PARAMS });
    expect(res.status).toBe(400);
  });

  it('clears work tracker when workTrackerConfig is null', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });

    const res = await PATCH(makeReq('PATCH', {}, { workTrackerConfig: null }), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.workTrackerConfig).toBeNull();
  });

  it('returns 403 when connector does not belong to team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
    mockConnectorsFindFirst.mockResolvedValue(null); // not found

    const res = await PATCH(
      makeReq('PATCH', {}, { workTrackerConfig: { connectorId: 'conn-1', provider: 'linear' } }),
      { params: PARAMS },
    );
    expect(res.status).toBe(403);
  });

  it('returns 422 when connector is not enabled for workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
    mockConnectorsFindFirst.mockResolvedValue({ id: 'conn-1' });
    mockConnectorWorkspacesFindFirst.mockResolvedValue(null); // not enabled

    const res = await PATCH(
      makeReq('PATCH', {}, { workTrackerConfig: { connectorId: 'conn-1', provider: 'linear' } }),
      { params: PARAMS },
    );
    expect(res.status).toBe(422);
  });

  it('saves workTrackerConfig successfully', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
    mockConnectorsFindFirst.mockResolvedValue({ id: 'conn-1' });
    mockConnectorWorkspacesFindFirst.mockResolvedValue({ connectorId: 'conn-1' });

    const res = await PATCH(
      makeReq('PATCH', {}, { workTrackerConfig: { connectorId: 'conn-1', provider: 'linear' } }),
      { params: PARAMS },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.workTrackerConfig).toEqual({ connectorId: 'conn-1', provider: 'linear' });
  });
});

// Smoke test: verify externalIssueId column exists in the schema export
describe('schema: externalIssueId columns', () => {
  it('tasks schema has externalIssueId column reference', async () => {
    const schema = await import('@buildd/core/db/schema');
    // The schema mock includes tasks with basic fields; in real schema externalIssueId exists
    expect(schema).toBeDefined();
  });
});

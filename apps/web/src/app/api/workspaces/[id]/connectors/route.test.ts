import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => null as any);
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));
const mockConnectorWorkspacesFindMany = mock(() => [] as any[]);
const mockConnectorsFindFirst = mock(() => null as any);
const mockConnectorSharesFindFirst = mock(() => null as any);
const mockSecretsFindMany = mock(() => [] as any[]);
const mockInsert = mock(() => ({
  values: mock(() => ({
    onConflictDoUpdate: mock(() => Promise.resolve()),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      connectorWorkspaces: { findMany: mockConnectorWorkspacesFindMany },
      connectors: { findFirst: mockConnectorsFindFirst },
      connectorShares: { findFirst: mockConnectorSharesFindFirst },
      secrets: { findMany: mockSecretsFindMany },
    },
    insert: () => mockInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  inArray: (a: any, b: any) => ({ a, b, op: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  connectors: { id: 'id', teamId: 'teamId' },
  connectorWorkspaces: { workspaceId: 'workspaceId', enabled: 'enabled', connectorId: 'connectorId' },
  connectorShares: { connectorId: 'connectorId', sharedWithTeamId: 'sharedWithTeamId' },
  workspaces: { id: 'id' },
  secrets: { teamId: 'teamId', purpose: 'purpose', label: 'label' },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, PATCH } from './route';

const PARAMS = Promise.resolve({ id: 'ws-1' });

function makeReq(method = 'GET', headers: Record<string, string> = {}, body?: any) {
  return new NextRequest('http://localhost:3000/api/workspaces/ws-1/connectors', {
    method,
    headers: new Headers(headers),
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/workspaces/[id]/connectors', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockConnectorWorkspacesFindMany.mockReset();
    mockSecretsFindMany.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    mockSecretsFindMany.mockResolvedValue([]);
  });
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not accessible', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  it('returns enabled connectors for workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    mockConnectorWorkspacesFindMany.mockResolvedValue([
      {
        connectorId: 'conn-1',
        enabled: true,
        connector: { id: 'conn-1', name: 'Test', url: 'https://mcp.example.com', authMode: 'oauth' },
      },
    ]);
    mockSecretsFindMany.mockResolvedValue([
      { label: 'conn-1', tokenExpiresAt: null },
    ]);
    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connectors).toHaveLength(1);
    expect(data.connectors[0].status).toBe('connected');
  });
});

describe('PATCH /api/workspaces/[id]/connectors', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockConnectorsFindFirst.mockReset();
    mockConnectorSharesFindFirst.mockReset();
    mockInsert.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'admin' });
    mockConnectorsFindFirst.mockResolvedValue({ id: 'conn-1', teamId: 'team-1' });
    mockConnectorSharesFindFirst.mockResolvedValue(null);
    mockInsert.mockReturnValue({
      values: mock(() => ({
        onConflictDoUpdate: mock(() => Promise.resolve()),
      })),
    });
  });
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    const res = await PATCH(makeReq('PATCH', { 'content-type': 'application/json' }, { connectorId: 'conn-1', enabled: true }), { params: PARAMS });
    expect(res.status).toBe(401);
  });

  it('returns 400 when body is missing required fields', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await PATCH(makeReq('PATCH', { 'content-type': 'application/json' }, { connectorId: 'conn-1' }), { params: PARAMS });
    expect(res.status).toBe(400);
  });

  // §1b AC-2: a connector that is neither owned by nor shared to the workspace's
  // team is not visible — enabling it is rejected 404.
  it('returns 404 when connector does not exist', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindFirst.mockResolvedValue(null);
    const res = await PATCH(makeReq('PATCH', { 'content-type': 'application/json' }, { connectorId: 'conn-other', enabled: true }), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  it('returns 404 when connector belongs to another team and is not shared in', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindFirst.mockResolvedValue({ id: 'conn-other', teamId: 'team-other' });
    mockConnectorSharesFindFirst.mockResolvedValue(null);
    const res = await PATCH(makeReq('PATCH', { 'content-type': 'application/json' }, { connectorId: 'conn-other', enabled: true }), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  // §1b: a shared-in connector is enableable per workspace exactly like an owned one.
  it('enables a connector shared to the workspace team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindFirst.mockResolvedValue({ id: 'conn-shared', teamId: 'team-owner' });
    mockConnectorSharesFindFirst.mockResolvedValue({ connectorId: 'conn-shared', sharedWithTeamId: 'team-1' });
    const res = await PATCH(makeReq('PATCH', { 'content-type': 'application/json' }, { connectorId: 'conn-shared', enabled: true }), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('upserts connectorWorkspaces row', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await PATCH(makeReq('PATCH', { 'content-type': 'application/json' }, { connectorId: 'conn-1', enabled: true }), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});

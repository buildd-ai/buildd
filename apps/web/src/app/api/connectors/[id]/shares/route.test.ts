import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Table sentinels so db.insert/delete calls can be attributed by identity.
const connectorsTable = { id: 'id', teamId: 'teamId', name: 'name' };
const connectorSharesTable = { connectorId: 'connectorId', sharedWithTeamId: 'sharedWithTeamId' };
const teamsTable = { id: 'id', name: 'name' };
const teamMembersTable = { userId: 'userId', teamId: 'teamId' };

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockConnectorsFindFirst = mock(() => null as any);
const mockSharesFindFirst = mock(() => null as any);
const mockSharesFindMany = mock(() => [] as any[]);
const mockTeamsFindMany = mock(() => [] as any[]);
const mockTeamMembersFindFirst = mock(() => ({ role: 'owner' }) as any);
const mockDeleteReturning = mock(() => [] as any[]);

const insertCalls: { table: any; values: any }[] = [];
const deleteCalls: { table: any; where: any }[] = [];

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      connectors: { findFirst: mockConnectorsFindFirst },
      connectorShares: { findFirst: mockSharesFindFirst, findMany: mockSharesFindMany },
      teams: { findMany: mockTeamsFindMany },
      teamMembers: { findFirst: mockTeamMembersFindFirst },
    },
    insert: (table: any) => ({
      values: (values: any) => {
        insertCalls.push({ table, values });
        return { returning: () => [{ ...values, createdAt: new Date('2026-01-01') }] };
      },
    }),
    delete: (table: any) => ({
      where: (where: any) => {
        deleteCalls.push({ table, where });
        return { returning: () => mockDeleteReturning() };
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  inArray: (a: any, b: any) => ({ a, b, op: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  connectors: connectorsTable,
  connectorShares: connectorSharesTable,
  teams: teamsTable,
  teamMembers: teamMembersTable,
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, POST, DELETE } from './route';

const PARAMS = Promise.resolve({ id: 'conn-1' });
const CONNECTOR = { id: 'conn-1', teamId: 'team-1', name: 'github', url: 'https://mcp.example.com', authMode: 'oauth' as const };

function makeReq(method = 'GET', body?: any, url = 'http://localhost:3000/api/connectors/conn-1/shares') {
  return new NextRequest(url, {
    method,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  });
}

function resetAll() {
  process.env.NODE_ENV = 'production';
  mockGetCurrentUser.mockReset();
  mockAuthenticateApiKey.mockReset();
  mockGetUserTeamIds.mockReset();
  mockConnectorsFindFirst.mockReset();
  mockSharesFindFirst.mockReset();
  mockSharesFindMany.mockReset();
  mockTeamsFindMany.mockReset();
  mockTeamMembersFindFirst.mockReset();
  mockDeleteReturning.mockReset();
  insertCalls.length = 0;
  deleteCalls.length = 0;
  mockAuthenticateApiKey.mockResolvedValue(null);
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  // Actor belongs to the owner team and one other team.
  mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2']);
  mockConnectorsFindFirst.mockResolvedValue(CONNECTOR);
  mockSharesFindFirst.mockResolvedValue(null);
  mockSharesFindMany.mockResolvedValue([]);
  mockTeamsFindMany.mockResolvedValue([]);
  // Default: actor is an owner/admin of the team.
  mockTeamMembersFindFirst.mockResolvedValue({ role: 'owner' });
  mockDeleteReturning.mockReturnValue([]);
}

describe('GET /api/connectors/[id]/shares', () => {
  beforeEach(resetAll);
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the connector belongs to a team the actor is not in', async () => {
    mockConnectorsFindFirst.mockResolvedValue({ ...CONNECTOR, teamId: 'other-team' });
    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  it('lists shares with resolved team names', async () => {
    mockSharesFindMany.mockResolvedValue([
      { connectorId: 'conn-1', sharedWithTeamId: 'team-2', grantedByAccountId: 'acc-1', createdAt: new Date('2026-01-01') },
    ]);
    mockTeamsFindMany.mockResolvedValue([{ id: 'team-2', name: 'Team Two' }]);
    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.shares).toHaveLength(1);
    expect(data.shares[0].sharedWithTeamId).toBe('team-2');
    expect(data.shares[0].teamName).toBe('Team Two');
    expect(data.shares[0].grantedByAccountId).toBe('acc-1');
    // The UI share/transfer pickers exclude the owner team by this field.
    expect(data.ownerTeamId).toBe('team-1');
  });
});

describe('POST /api/connectors/[id]/shares', () => {
  beforeEach(resetAll);
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(makeReq('POST', { teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(401);
  });

  // §1b AC-4: only an admin of the OWNER team may create a share.
  it('returns 403 when the actor is a non-admin member of the owner team', async () => {
    mockTeamMembersFindFirst.mockResolvedValue({ role: 'member' });
    const res = await POST(makeReq('POST', { teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(403);
    expect(insertCalls).toHaveLength(0);
  });

  it('returns 400 when sharing to the owner team itself (no self-share)', async () => {
    const res = await POST(makeReq('POST', { teamId: 'team-1' }), { params: PARAMS });
    expect(res.status).toBe(400);
    expect(insertCalls).toHaveLength(0);
  });

  it('returns 400 when teamId is missing', async () => {
    const res = await POST(makeReq('POST', {}), { params: PARAMS });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the target team is not one of the actor\'s teams', async () => {
    const res = await POST(makeReq('POST', { teamId: 'team-9' }), { params: PARAMS });
    expect(res.status).toBe(404);
    expect(insertCalls).toHaveLength(0);
  });

  it('is idempotent: duplicate share returns 200 with the existing row and does not insert', async () => {
    const existing = { connectorId: 'conn-1', sharedWithTeamId: 'team-2', grantedByAccountId: null, createdAt: new Date('2026-01-01') };
    mockSharesFindFirst.mockResolvedValue(existing);
    const res = await POST(makeReq('POST', { teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.share.sharedWithTeamId).toBe('team-2');
    expect(insertCalls).toHaveLength(0);
  });

  it('creates a share and returns 201', async () => {
    const res = await POST(makeReq('POST', { teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.share.sharedWithTeamId).toBe('team-2');
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].table).toBe(connectorSharesTable);
    expect(insertCalls[0].values.connectorId).toBe('conn-1');
    expect(insertCalls[0].values.sharedWithTeamId).toBe('team-2');
  });
});

describe('DELETE /api/connectors/[id]/shares', () => {
  beforeEach(resetAll);
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await DELETE(makeReq('DELETE', { teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(401);
  });

  // §1b AC-4: only an admin of the OWNER team may revoke a share.
  it('returns 403 when the actor is a non-admin member of the owner team', async () => {
    mockTeamMembersFindFirst.mockResolvedValue({ role: 'member' });
    const res = await DELETE(makeReq('DELETE', { teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(403);
    expect(deleteCalls).toHaveLength(0);
  });

  it('returns 404 when revoking a share that does not exist', async () => {
    mockDeleteReturning.mockReturnValue([]);
    const res = await DELETE(makeReq('DELETE', { teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  it('revokes an existing share via body teamId', async () => {
    mockDeleteReturning.mockReturnValue([{ connectorId: 'conn-1', sharedWithTeamId: 'team-2' }]);
    const res = await DELETE(makeReq('DELETE', { teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].table).toBe(connectorSharesTable);
  });

  it('revokes an existing share via ?teamId= query param', async () => {
    mockDeleteReturning.mockReturnValue([{ connectorId: 'conn-1', sharedWithTeamId: 'team-2' }]);
    const res = await DELETE(
      makeReq('DELETE', undefined, 'http://localhost:3000/api/connectors/conn-1/shares?teamId=team-2'),
      { params: PARAMS },
    );
    expect(res.status).toBe(200);
  });

  it('returns 400 when no teamId is provided', async () => {
    const res = await DELETE(makeReq('DELETE'), { params: PARAMS });
    expect(res.status).toBe(400);
  });
});

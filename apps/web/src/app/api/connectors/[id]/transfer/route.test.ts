import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Table sentinels so db.update/delete calls can be attributed by identity.
const connectorsTable = { id: 'id', teamId: 'teamId', name: 'name' };
const connectorSharesTable = { connectorId: 'connectorId', sharedWithTeamId: 'sharedWithTeamId' };
const secretsTable = { teamId: 'teamId', purpose: 'purpose', label: 'label' };
const teamMembersTable = { userId: 'userId', teamId: 'teamId' };

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockConnectorsFindFirst = mock(() => null as any);
const mockTeamMembersFindFirst = mock(() => ({ role: 'owner' }) as any);
const mockConnectorsUpdateReturning = mock(() => [] as any[]);

const updateCalls: { table: any; set: any; where: any }[] = [];
const deleteCalls: { table: any; where: any }[] = [];

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      connectors: { findFirst: mockConnectorsFindFirst },
      teamMembers: { findFirst: mockTeamMembersFindFirst },
    },
    update: (table: any) => ({
      set: (set: any) => ({
        where: (where: any) => {
          updateCalls.push({ table, set, where });
          if (table === connectorsTable) {
            return { returning: () => mockConnectorsUpdateReturning() };
          }
          // secrets update is awaited without .returning()
          return Promise.resolve([]);
        },
      }),
    }),
    delete: (table: any) => ({
      where: (where: any) => {
        deleteCalls.push({ table, where });
        return Promise.resolve([]);
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
  secrets: secretsTable,
  teamMembers: teamMembersTable,
}));

const originalNodeEnv = process.env.NODE_ENV;

import { POST } from './route';

const PARAMS = Promise.resolve({ id: 'conn-1' });
const CONNECTOR = { id: 'conn-1', teamId: 'team-1', name: 'github', url: 'https://mcp.example.com', authMode: 'oauth' as const };

function makeReq(body?: any) {
  return new NextRequest('http://localhost:3000/api/connectors/conn-1/transfer', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('POST /api/connectors/[id]/transfer', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockConnectorsFindFirst.mockReset();
    mockTeamMembersFindFirst.mockReset();
    mockConnectorsUpdateReturning.mockReset();
    updateCalls.length = 0;
    deleteCalls.length = 0;
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    // Actor belongs to both the owner team and the target team.
    mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2']);
    // First findFirst resolves the connector; second is the name-collision probe.
    mockConnectorsFindFirst.mockResolvedValueOnce(CONNECTOR).mockResolvedValue(null);
    // Default: actor is admin of every team checked (owner then target).
    mockTeamMembersFindFirst.mockResolvedValue({ role: 'admin' });
    mockConnectorsUpdateReturning.mockReturnValue([{ ...CONNECTOR, teamId: 'team-2' }]);
  });
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(makeReq({ teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the connector belongs to a team the actor is not in', async () => {
    mockConnectorsFindFirst.mockReset();
    mockConnectorsFindFirst.mockResolvedValue({ ...CONNECTOR, teamId: 'other-team' });
    const res = await POST(makeReq({ teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  // §1b: only an admin of the current OWNER team may transfer.
  it('returns 403 when the actor is a non-admin member of the owner team', async () => {
    mockTeamMembersFindFirst.mockResolvedValue({ role: 'member' });
    const res = await POST(makeReq({ teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(403);
    expect(updateCalls).toHaveLength(0);
  });

  it('returns 403 when the actor is not an admin of the target team', async () => {
    mockTeamMembersFindFirst
      .mockResolvedValueOnce({ role: 'admin' })   // owner-team check
      .mockResolvedValueOnce({ role: 'member' }); // target-team check
    const res = await POST(makeReq({ teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(403);
    expect(updateCalls).toHaveLength(0);
  });

  it('returns 400 when transferring to the current owner team', async () => {
    const res = await POST(makeReq({ teamId: 'team-1' }), { params: PARAMS });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the target team is not one of the actor\'s teams', async () => {
    const res = await POST(makeReq({ teamId: 'team-9' }), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  it('returns 409 connector_name_taken when the target team already owns a connector with the same name', async () => {
    mockConnectorsFindFirst.mockReset();
    mockConnectorsFindFirst
      .mockResolvedValueOnce(CONNECTOR)                          // resolve
      .mockResolvedValueOnce({ id: 'conn-other', teamId: 'team-2', name: 'github' }); // collision
    const res = await POST(makeReq({ teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('connector_name_taken');
    expect(updateCalls).toHaveLength(0);
  });

  it('transfers ownership: reassigns teamId, re-keys credential secrets, clears the new-owner share row', async () => {
    const res = await POST(makeReq({ teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connector.teamId).toBe('team-2');

    // Connector reassignment guards on the current owner (atomic UPDATE...WHERE).
    const connectorUpdate = updateCalls.find(c => c.table === connectorsTable);
    expect(connectorUpdate).toBeDefined();
    expect(connectorUpdate!.set.teamId).toBe('team-2');
    expect(connectorUpdate!.where.args).toContainEqual({ a: 'teamId', b: 'team-1', op: 'eq' });

    // Credential secrets re-keyed to the new owner team (label=id and id:refresh).
    const secretsUpdate = updateCalls.find(c => c.table === secretsTable);
    expect(secretsUpdate).toBeDefined();
    expect(secretsUpdate!.set.teamId).toBe('team-2');
    const labelClause = secretsUpdate!.where.args.find((x: any) => x.op === 'inArray');
    expect(labelClause.b).toEqual(['conn-1', 'conn-1:refresh']);

    // The new owner's share row (now implicit) is deleted; others untouched.
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].table).toBe(connectorSharesTable);
    expect(deleteCalls[0].where.args).toContainEqual({ a: 'sharedWithTeamId', b: 'team-2', op: 'eq' });
  });

  it('returns 409 when the connector was concurrently transferred (guard row missing)', async () => {
    mockConnectorsUpdateReturning.mockReturnValue([]);
    const res = await POST(makeReq({ teamId: 'team-2' }), { params: PARAMS });
    expect(res.status).toBe(409);
  });
});

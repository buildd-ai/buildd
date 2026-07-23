import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const workspacesTable = { id: 'id', teamId: 'teamId' };
const artifactsTable = { workspaceId: 'workspaceId' };

const mockAuthenticate = mock(async () => ({ type: 'session', teamIds: ['team-src', 'team-dst'], userId: 'u1' }) as any);
const mockIsTeamAdmin = mock(async () => true);
const mockWorkspaceFindFirst = mock(async () => ({ id: 'ws-1', teamId: 'team-src' }) as any);
const mockCollect = mock(async () => ({ workspace: { id: 'ws-1' } }) as any);
const mockClassify = mock(() => ({ destinationTeamName: 'Cue', precheck: { status: 'PASS' }, requiredAcks: [] }) as any);
const mockSign = mock(() => 'signed-token');
const insertCalls: any[] = [];

mock.module('@/lib/migrate-access', () => ({
  authenticateMigration: mockAuthenticate,
  isTeamAdmin: mockIsTeamAdmin,
}));
mock.module('@/lib/workspace-migration', () => ({
  collectMigrationSnapshot: mockCollect,
  classifyMigration: mockClassify,
  signDryRunToken: mockSign,
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { workspaces: { findFirst: mockWorkspaceFindFirst } },
    insert: (table: any) => ({ values: (values: any) => { insertCalls.push({ table, values }); return Promise.resolve([]); } }),
  },
}));
mock.module('@buildd/core/db/schema', () => ({ workspaces: workspacesTable, artifacts: artifactsTable }));
mock.module('drizzle-orm', () => ({ eq: (a: any, b: any) => ({ a, b }) }));

import { POST } from './route';

const PARAMS = Promise.resolve({ id: 'ws-1' });
function makeReq(body?: any) {
  return new NextRequest('http://localhost/api/workspaces/ws-1/migrate/precheck', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('POST /api/workspaces/[id]/migrate/precheck', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuthenticate.mockReset();
    mockAuthenticate.mockResolvedValue({ type: 'session', teamIds: ['team-src', 'team-dst'], userId: 'u1' } as any);
    mockIsTeamAdmin.mockReset();
    mockIsTeamAdmin.mockResolvedValue(true);
    mockWorkspaceFindFirst.mockReset();
    mockWorkspaceFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-src' } as any);
    mockCollect.mockReset();
    mockCollect.mockResolvedValue({ workspace: { id: 'ws-1' } } as any);
    mockClassify.mockReset();
    mockClassify.mockReturnValue({ destinationTeamName: 'Cue', precheck: { status: 'PASS' }, requiredAcks: [] } as any);
    mockSign.mockReset();
    mockSign.mockReturnValue('signed-token');
    insertCalls.length = 0;
  });

  it('401 when unauthenticated', async () => {
    mockAuthenticate.mockResolvedValue(null as any);
    expect((await POST(makeReq({ destinationTeamId: 'team-dst' }), { params: PARAMS })).status).toBe(401);
  });

  it('404 when the workspace is not in the actor\'s teams', async () => {
    mockWorkspaceFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-other' } as any);
    expect((await POST(makeReq({ destinationTeamId: 'team-dst' }), { params: PARAMS })).status).toBe(404);
  });

  it('400 when destinationTeamId missing', async () => {
    expect((await POST(makeReq({}), { params: PARAMS })).status).toBe(400);
  });

  it('400 when destination equals source', async () => {
    const res = await POST(makeReq({ destinationTeamId: 'team-src' }), { params: PARAMS });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('same_team');
  });

  it('404 when destination team not in actor\'s teams', async () => {
    const res = await POST(makeReq({ destinationTeamId: 'team-nope' }), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  it('403 when the session user is not admin on both teams', async () => {
    mockIsTeamAdmin.mockImplementation(async (_u: string, t: string) => t !== 'team-dst');
    const res = await POST(makeReq({ destinationTeamId: 'team-dst' }), { params: PARAMS });
    expect(res.status).toBe(403);
  });

  it('returns the report and a signed dryRunToken on success', async () => {
    const res = await POST(makeReq({ destinationTeamId: 'team-dst' }), { params: PARAMS });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRunToken).toBe('signed-token');
    expect(body.report.precheck.status).toBe('PASS');
    // Audit artifact persisted on the source workspace.
    expect(insertCalls.length).toBe(1);
  });

  it('still returns 200 with the report when precheck FAILs (UI blocks, not the API)', async () => {
    mockClassify.mockReturnValue({ destinationTeamName: 'Cue', precheck: { status: 'FAIL' }, requiredAcks: [] } as any);
    const res = await POST(makeReq({ destinationTeamId: 'team-dst' }), { params: PARAMS });
    expect(res.status).toBe(200);
    expect((await res.json()).report.precheck.status).toBe('FAIL');
  });
});

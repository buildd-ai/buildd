import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const migrationLogTable = { runId: 'runId' };

const mockAuthenticate = mock(async () => ({ type: 'session', teamIds: ['team-dst'], userId: 'u1' }) as any);
const mockIsTeamAdmin = mock(async () => true);
const mockLedgerFindMany = mock(async () => [
  { runId: 'run-1', workspaceId: 'ws-1', sourceTeamId: 'team-src', destinationTeamId: 'team-dst', phase: 'workspace_team', status: 'completed' },
  { runId: 'run-1', workspaceId: 'ws-1', sourceTeamId: 'team-src', destinationTeamId: 'team-dst', phase: 'delete_secrets', status: 'failed' },
] as any);
const mockCollect = mock(async () => ({ workspace: { id: 'ws-1' } }) as any);
const mockClassify = mock(() => ({ precheck: { status: 'PASS' }, requiredAcks: [] }) as any);
const mockExecute = mock(async () => ({ outcomes: [], checklistArtifactId: 'art-1' }) as any);

class MigrationPhaseError extends Error { constructor(public phase: string, public cause: unknown) { super('x'); } }

mock.module('@/lib/migrate-access', () => ({ authenticateMigration: mockAuthenticate, isTeamAdmin: mockIsTeamAdmin }));
mock.module('@/lib/workspace-migration', () => ({
  collectMigrationSnapshot: mockCollect, classifyMigration: mockClassify,
  executeMigrationPhases: mockExecute, MigrationPhaseError,
}));
mock.module('@buildd/core/db', () => ({ db: { query: { migrationLog: { findMany: mockLedgerFindMany } } } }));
mock.module('@buildd/core/db/schema', () => ({ migrationLog: migrationLogTable }));
mock.module('drizzle-orm', () => ({ eq: (a: any, b: any) => ({ a, b }) }));

import { POST } from './route';

const PARAMS = Promise.resolve({ id: 'ws-1' });
function makeReq(body?: any) {
  return new NextRequest('http://localhost/api/workspaces/ws-1/migrate/repair', {
    method: 'POST', headers: new Headers({ 'content-type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('POST /api/workspaces/[id]/migrate/repair', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    for (const m of [mockAuthenticate, mockIsTeamAdmin, mockLedgerFindMany, mockCollect, mockClassify, mockExecute]) m.mockReset();
    mockAuthenticate.mockResolvedValue({ type: 'session', teamIds: ['team-dst'], userId: 'u1' } as any);
    mockIsTeamAdmin.mockResolvedValue(true);
    mockLedgerFindMany.mockResolvedValue([
      { runId: 'run-1', workspaceId: 'ws-1', sourceTeamId: 'team-src', destinationTeamId: 'team-dst', phase: 'workspace_team', status: 'completed' },
      { runId: 'run-1', workspaceId: 'ws-1', sourceTeamId: 'team-src', destinationTeamId: 'team-dst', phase: 'delete_secrets', status: 'failed' },
    ] as any);
    mockCollect.mockResolvedValue({ workspace: { id: 'ws-1' } } as any);
    mockClassify.mockReturnValue({ precheck: { status: 'PASS' }, requiredAcks: [] } as any);
    mockExecute.mockResolvedValue({ outcomes: [], checklistArtifactId: 'art-1' } as any);
  });

  it('400 when runId missing', async () => {
    expect((await POST(makeReq({}), { params: PARAMS })).status).toBe(400);
  });

  it('404 when the run is unknown', async () => {
    mockLedgerFindMany.mockResolvedValue([] as any);
    expect((await POST(makeReq({ runId: 'nope' }), { params: PARAMS })).status).toBe(404);
  });

  it('400 when the run belongs to a different workspace', async () => {
    mockLedgerFindMany.mockResolvedValue([{ runId: 'run-1', workspaceId: 'ws-OTHER', sourceTeamId: 's', destinationTeamId: 'team-dst', status: 'failed' }] as any);
    expect((await POST(makeReq({ runId: 'run-1' }), { params: PARAMS })).status).toBe(400);
  });

  it('403 when not admin on the destination team', async () => {
    mockIsTeamAdmin.mockResolvedValue(false);
    expect((await POST(makeReq({ runId: 'run-1' }), { params: PARAMS })).status).toBe(403);
  });

  it('short-circuits when every phase already completed', async () => {
    mockLedgerFindMany.mockResolvedValue([
      { runId: 'run-1', workspaceId: 'ws-1', sourceTeamId: 'team-src', destinationTeamId: 'team-dst', phase: 'workspace_team', status: 'completed' },
    ] as any);
    const res = await POST(makeReq({ runId: 'run-1' }), { params: PARAMS });
    expect((await res.json()).alreadyComplete).toBe(true);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('resumes with the same runId so completed phases are skipped', async () => {
    const res = await POST(makeReq({ runId: 'run-1' }), { params: PARAMS });
    expect(res.status).toBe(200);
    expect((await res.json()).resumed).toBe(true);
    expect((mockExecute.mock.calls[0][0] as any).runId).toBe('run-1');
  });
});

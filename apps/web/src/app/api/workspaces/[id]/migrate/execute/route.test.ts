import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const workspacesTable = { id: 'id', teamId: 'teamId' };

class MigrationPhaseError extends Error {
  constructor(public phase: string, public cause: unknown) { super('phase failed'); this.name = 'MigrationPhaseError'; }
}

const mockAuthenticate = mock(async () => ({ type: 'session', teamIds: ['team-src', 'team-dst'], userId: 'u1' }) as any);
const mockIsTeamAdmin = mock(async () => true);
const mockWorkspaceFindFirst = mock(async () => ({ id: 'ws-1', teamId: 'team-src' }) as any);
const mockCollect = mock(async () => ({ workspace: { id: 'ws-1' } }) as any);
const mockClassify = mock(() => ({ precheck: { status: 'PASS' }, requiredAcks: [] }) as any);
const mockVerify = mock(() => ({ valid: true }) as any);
const mockExecute = mock(async () => ({ outcomes: [{ phase: 'workspace_team', status: 'completed', detail: {} }], checklistArtifactId: 'art-1' }) as any);

mock.module('@/lib/migrate-access', () => ({ authenticateMigration: mockAuthenticate, isTeamAdmin: mockIsTeamAdmin }));
mock.module('@/lib/workspace-migration', () => ({
  collectMigrationSnapshot: mockCollect,
  classifyMigration: mockClassify,
  verifyDryRunToken: mockVerify,
  executeMigrationPhases: mockExecute,
  MigrationPhaseError,
}));
mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findFirst: mockWorkspaceFindFirst } } } }));
mock.module('@buildd/core/db/schema', () => ({ workspaces: workspacesTable }));
mock.module('drizzle-orm', () => ({ eq: (a: any, b: any) => ({ a, b }) }));

import { POST } from './route';

const PARAMS = Promise.resolve({ id: 'ws-1' });
function makeReq(body?: any) {
  return new NextRequest('http://localhost/api/workspaces/ws-1/migrate/execute', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  });
}
const okBody = { destinationTeamId: 'team-dst', dryRunToken: 'tok', confirmedItems: [] };

describe('POST /api/workspaces/[id]/migrate/execute', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    for (const m of [mockAuthenticate, mockIsTeamAdmin, mockWorkspaceFindFirst, mockCollect, mockClassify, mockVerify, mockExecute]) m.mockReset();
    mockAuthenticate.mockResolvedValue({ type: 'session', teamIds: ['team-src', 'team-dst'], userId: 'u1' } as any);
    mockIsTeamAdmin.mockResolvedValue(true);
    mockWorkspaceFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-src' } as any);
    mockCollect.mockResolvedValue({ workspace: { id: 'ws-1' } } as any);
    mockClassify.mockReturnValue({ precheck: { status: 'PASS' }, requiredAcks: [] } as any);
    mockVerify.mockReturnValue({ valid: true } as any);
    mockExecute.mockResolvedValue({ outcomes: [{ phase: 'workspace_team', status: 'completed', detail: {} }], checklistArtifactId: 'art-1' } as any);
  });

  it('rejects a stale dry-run token', async () => {
    mockVerify.mockReturnValue({ valid: false, reason: 'stale' } as any);
    const res = await POST(makeReq(okBody), { params: PARAMS });
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.error).toBe('invalid_token');
    expect(b.reason).toBe('stale');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('rejects a tampered token', async () => {
    mockVerify.mockReturnValue({ valid: false, reason: 'tampered' } as any);
    expect((await POST(makeReq(okBody), { params: PARAMS })).status).toBe(400);
  });

  it('rejects when a required WILL_BREAK item is not acknowledged', async () => {
    mockClassify.mockReturnValue({ precheck: { status: 'PASS' }, requiredAcks: ['account:a1', 'secret:custom:X'] } as any);
    const res = await POST(makeReq({ ...okBody, confirmedItems: ['secret:custom:X'] }), { params: PARAMS });
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.error).toBe('unconfirmed_items');
    expect(b.missing).toEqual(['account:a1']);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('409 when the server-recomputed precheck FAILs', async () => {
    mockClassify.mockReturnValue({ precheck: { status: 'FAIL' }, requiredAcks: [] } as any);
    expect((await POST(makeReq(okBody), { params: PARAMS })).status).toBe(409);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('executes with source team captured before the move, returning outcomes', async () => {
    mockClassify.mockReturnValue({ precheck: { status: 'PASS' }, requiredAcks: ['account:a1'] } as any);
    const res = await POST(makeReq({ ...okBody, confirmedItems: ['account:a1'] }), { params: PARAMS });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.ok).toBe(true);
    expect(b.destinationTeamId).toBe('team-dst');
    expect(b.checklistArtifactId).toBe('art-1');
    const call = mockExecute.mock.calls[0][0] as any;
    expect(call.sourceTeamId).toBe('team-src');
    expect(call.destinationTeamId).toBe('team-dst');
    expect(typeof call.runId).toBe('string');
  });

  it('surfaces a phase failure as 500 with the failed phase and runId', async () => {
    mockExecute.mockRejectedValue(new MigrationPhaseError('delete_secrets', new Error('boom')));
    const res = await POST(makeReq(okBody), { params: PARAMS });
    expect(res.status).toBe(500);
    const b = await res.json();
    expect(b.error).toBe('migration_failed');
    expect(b.phase).toBe('delete_secrets');
    expect(typeof b.runId).toBe('string');
  });

  it('403 when session user is not admin on both teams', async () => {
    mockIsTeamAdmin.mockImplementation(async (_u: string, t: string) => t !== 'team-dst');
    expect((await POST(makeReq(okBody), { params: PARAMS })).status).toBe(403);
  });
});

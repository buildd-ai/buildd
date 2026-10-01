import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-a';
const ID = '22222222-2222-4222-8222-222222222222';

let viewer: any;
let row: any;
const blockedWorkspaces = new Set<string>();

const mockVerify = mock(async (id: string) => ({ backendId: id, status: 'failing', error: 'PUT failed', warnings: [], verifiedAt: 'now' }));

mock.module('@/lib/evidence-backend-access', () => ({
  filterReachableEvidenceBackends: async (_v: unknown, rows: any[]) => rows.filter((r) => !r.workspaceId || !blockedWorkspaces.has(r.workspaceId)),
}));
mock.module('@/lib/experiment-access', () => ({ resolveExperimentViewer: async () => viewer }));
mock.module('drizzle-orm', () => ({ eq: (c: unknown, v: unknown) => ({ c, v }) }));
mock.module('@buildd/core/db/schema', () => ({ evidenceBackends: new Proxy({}, { get: (_t, p) => String(p) }) }));
mock.module('@buildd/core/db', () => ({ db: { query: { evidenceBackends: { findFirst: async () => row } } } }));
mock.module('@/lib/evidence-backend', () => ({ verifyEvidenceBackend: mockVerify }));

const { POST } = await import('./route');

const call = (id = ID) => POST(new NextRequest(`http://localhost/api/evidence-backends/${id}/verify`, { method: 'POST' }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  viewer = { ok: true, viewer: { teamId: TEAM, role: 'admin', userId: 'u-1' } };
  row = { id: ID, teamId: TEAM };
  mockVerify.mockClear();
});

describe('POST /api/evidence-backends/[id]/verify', () => {
  it('404s a malformed id', async () => {
    expect((await call('nope')).status).toBe(404);
  });

  it('404s a backend from another team like a missing one', async () => {
    row = { id: ID, teamId: 'team-b' };
    expect((await call()).status).toBe(404);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('404s a workspace-scoped backend the caller cannot reach', async () => {
    row = { id: ID, teamId: TEAM, workspaceId: 'ws-restricted' };
    blockedWorkspaces.add('ws-restricted');
    expect((await call()).status).toBe(404);
    expect(mockVerify).not.toHaveBeenCalled();
    blockedWorkspaces.clear();
  });

  it('403s a member', async () => {
    viewer = { ok: true, viewer: { teamId: TEAM, role: 'member', userId: 'u-1' } };
    expect((await call()).status).toBe(403);
  });

  it('answers 200 with the failing result rather than an error status', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('failing');
    expect(mockVerify).toHaveBeenCalledWith(ID);
  });
});

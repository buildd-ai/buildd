import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-a';
const ID = '22222222-2222-4222-8222-222222222222';

let viewer: any;
let row: any;
let updateSet: any;
let deleted = false;
const blockedWorkspaces = new Set<string>();
let endpointVerdict: { ok: boolean; error?: string };

const mockSet = mock(async (..._a: any[]) => 'sec-1');
const mockDeleteSecret = mock(async (..._a: any[]) => {});
const mockVerify = mock(async (id: string) => ({ backendId: id, status: 'ok', error: null, warnings: [], verifiedAt: 'now' }));

mock.module('@/lib/evidence-backend-access', () => ({
  filterReachableEvidenceBackends: async (_v: unknown, rows: any[]) => rows.filter((r) => !r.workspaceId || !blockedWorkspaces.has(r.workspaceId)),
}));
mock.module('@/lib/experiment-access', () => ({ resolveExperimentViewer: async () => viewer }));
mock.module('drizzle-orm', () => ({ eq: (c: unknown, v: unknown) => ({ c, v }) }));
mock.module('@buildd/core/db/schema', () => ({ evidenceBackends: new Proxy({}, { get: (_t, p) => String(p) }) }));
mock.module('@buildd/core/secrets', () => ({ getSecretsProvider: () => ({ set: mockSet, delete: mockDeleteSecret }) }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { evidenceBackends: { findFirst: async () => row } },
    update: () => ({ set: (s: any) => ({ where: async () => { updateSet = s; } }) }),
    delete: () => ({ where: async () => { deleted = true; } }),
  },
}));
mock.module('@/lib/evidence-backend', () => ({
  EVIDENCE_CREDENTIAL_PURPOSE: 'evidence_storage_credential',
  validateEvidenceEndpoint: async () => endpointVerdict,
  verifyEvidenceBackend: mockVerify,
  parseEvidenceCredentials: (v: any) => (v && v.accessKeyId && v.secretAccessKey ? v : null),
  toEvidenceBackendDTO: (r: any) => ({ id: r.id, bucket: r.bucket, hasCredential: !!r.credentialSecretId }),
}));

const { GET, PATCH, DELETE } = await import('./route');

const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown) => new NextRequest(`http://localhost/api/evidence-backends/${ID}`, {
  method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeEach(() => {
  viewer = { ok: true, viewer: { teamId: TEAM, role: 'admin', userId: 'u-1' } };
  row = { id: ID, teamId: TEAM, provider: 's3_compatible', bucket: 'b', sse: 'none', kmsKeyId: null, credentialSecretId: 'sec-1' };
  updateSet = undefined;
  deleted = false;
  endpointVerdict = { ok: true };
  mockSet.mockClear();
  mockDeleteSecret.mockClear();
  mockVerify.mockClear();
});

describe('GET /api/evidence-backends/[id] — workspace reach', () => {
  it('404s a workspace-scoped backend the caller cannot reach, like a missing one', async () => {
    row = { ...row, workspaceId: 'ws-restricted' };
    blockedWorkspaces.add('ws-restricted');
    expect((await GET(req('GET'), ctx())).status).toBe(404);
    expect((await PATCH(req('PATCH', { bucket: 'x' }), ctx())).status).toBe(404);
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(404);
    expect(deleted).toBe(false);
    blockedWorkspaces.clear();
  });
});

describe('GET /api/evidence-backends/[id]', () => {
  it('returns the backend to a member', async () => {
    viewer = { ok: true, viewer: { teamId: TEAM, role: 'member', userId: 'u-1' } };
    const res = await GET(req('GET'), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).backend.id).toBe(ID);
  });

  it('404s another team\'s backend and a malformed id', async () => {
    row = { ...row, teamId: 'team-b' };
    expect((await GET(req('GET'), ctx())).status).toBe(404);
    expect((await GET(req('GET'), ctx('nope'))).status).toBe(404);
  });
});

describe('PATCH /api/evidence-backends/[id]', () => {
  it('403s a member', async () => {
    viewer = { ok: true, viewer: { teamId: TEAM, role: 'member', userId: 'u-1' } };
    expect((await PATCH(req('PATCH', { bucket: 'other-bucket' }), ctx())).status).toBe(403);
    expect(updateSet).toBeUndefined();
  });

  it('400s an endpoint that resolves to a private address', async () => {
    endpointVerdict = { ok: false, error: 'endpoint must not point at a private or link-local address' };
    const res = await PATCH(req('PATCH', { endpoint: 'https://10.0.0.1' }), ctx());
    expect(res.status).toBe(400);
    expect(updateSet).toBeUndefined();
  });

  it('400s a provider change', async () => {
    expect((await PATCH(req('PATCH', { provider: 'r2' }), ctx())).status).toBe(400);
  });

  it('updates fields, resets status, and re-verifies', async () => {
    const res = await PATCH(req('PATCH', { retentionDays: 90 }), ctx());
    expect(res.status).toBe(200);
    expect(updateSet).toMatchObject({ retentionDays: 90, status: 'unverified' });
    expect(mockVerify).toHaveBeenCalledWith(ID);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('replaces the credential in place on the same secret', async () => {
    await PATCH(req('PATCH', { credentials: { accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret' } }), ctx());
    expect(mockSet.mock.calls[0][0]).toBe('sec-1');
    expect(mockSet.mock.calls[0][2]).toMatchObject({ teamId: TEAM, purpose: 'evidence_storage_credential' });
  });
});

describe('DELETE /api/evidence-backends/[id]', () => {
  it('403s a member', async () => {
    viewer = { ok: true, viewer: { teamId: TEAM, role: 'member', userId: 'u-1' } };
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(403);
    expect(deleted).toBe(false);
  });

  it('removes the backend and its credential', async () => {
    const res = await DELETE(req('DELETE'), ctx());
    expect(res.status).toBe(200);
    expect(deleted).toBe(true);
    expect(mockDeleteSecret).toHaveBeenCalledWith('sec-1');
  });
});

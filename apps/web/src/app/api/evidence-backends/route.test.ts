import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-a';
const WS = '11111111-1111-4111-8111-111111111111';

type Role = 'member' | 'admin' | 'owner';
let viewer: any;
let existingBackend: any;
let workspaceRow: any;
let listRows: any[];
let insertedValues: any;
let endpointVerdict: { ok: boolean; error?: string };

const mockSet = mock(async (..._a: any[]) => 'sec-new');
const mockDeleteSecret = mock(async (..._a: any[]) => {});
const mockVerify = mock(async (id: string) => ({ backendId: id, status: 'ok', error: null, warnings: [], verifiedAt: 'now' }));
const mockValidate = mock(async (_e: string) => endpointVerdict);

mock.module('@/lib/experiment-access', () => ({ resolveExperimentViewer: async () => viewer }));
mock.module('drizzle-orm', () => ({
  eq: (c: unknown, v: unknown) => ({ c, v }),
  and: (...a: unknown[]) => a,
  isNull: (c: unknown) => ({ isNull: c }),
  desc: (c: unknown) => c,
}));
mock.module('@buildd/core/db/schema', () => ({
  evidenceBackends: new Proxy({}, { get: (_t, p) => `evidenceBackends.${String(p)}` }),
  workspaces: new Proxy({}, { get: (_t, p) => `workspaces.${String(p)}` }),
}));
mock.module('@buildd/core/config', () => ({ config: { storageBucket: 'default-bucket' } }));
mock.module('@buildd/core/secrets', () => ({ getSecretsProvider: () => ({ set: mockSet, delete: mockDeleteSecret }) }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      evidenceBackends: {
        findMany: async () => listRows,
        findFirst: async () => existingBackend,
      },
      workspaces: { findFirst: async () => workspaceRow },
    },
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          insertedValues = v;
          return [{ id: 'be-new', createdAt: new Date(), updatedAt: new Date(), status: 'unverified', lastVerifiedAt: null, lastError: null, ...v }];
        },
      }),
    }),
  },
}));
mock.module('@/lib/evidence-backend', () => ({
  EVIDENCE_CREDENTIAL_PURPOSE: 'evidence_storage_credential',
  validateEvidenceEndpoint: mockValidate,
  verifyEvidenceBackend: mockVerify,
  parseEvidenceCredentials: (v: any) => (v && v.accessKeyId && v.secretAccessKey ? v : null),
  toEvidenceBackendDTO: (r: any) => ({ id: r.id, bucket: r.bucket, hasCredential: !!r.credentialSecretId }),
}));

const { GET, POST } = await import('./route');

const post = (body: unknown, url = 'http://localhost/api/evidence-backends') =>
  POST(new NextRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

const valid = {
  provider: 's3_compatible',
  endpoint: 'https://s3.customer.example.com',
  bucket: 'customer-bucket',
  credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'shh-secret' },
};

function as(role: Role) {
  viewer = { ok: true, viewer: { teamId: TEAM, role, userId: 'u-1' } };
}

beforeEach(() => {
  as('admin');
  existingBackend = undefined;
  workspaceRow = { id: WS };
  listRows = [];
  insertedValues = undefined;
  endpointVerdict = { ok: true };
  mockSet.mockClear();
  mockDeleteSecret.mockClear();
  mockVerify.mockClear();
  mockValidate.mockClear();
});

describe('GET /api/evidence-backends', () => {
  it('passes a 401 through', async () => {
    viewer = { ok: false, status: 401, error: 'Unauthorized' };
    const res = await GET(new NextRequest('http://localhost/api/evidence-backends'));
    expect(res.status).toBe(401);
  });

  it('lists backends for a member without exposing the credential', async () => {
    as('member');
    listRows = [{ id: 'be-1', bucket: 'b', credentialSecretId: 'sec-1' }];
    const res = await GET(new NextRequest('http://localhost/api/evidence-backends'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.canManage).toBe(false);
    expect(json.backends).toEqual([{ id: 'be-1', bucket: 'b', hasCredential: true }]);
    expect(JSON.stringify(json)).not.toContain('sec-1');
  });
});

describe('POST /api/evidence-backends', () => {
  it('403s a member', async () => {
    as('member');
    const res = await post(valid);
    expect(res.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('400s an invalid body without storing anything', async () => {
    const res = await post({ provider: 'gcs' });
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('400s an endpoint that resolves to a private address, before storing a credential', async () => {
    endpointVerdict = { ok: false, error: 'endpoint must not point at a private or link-local address' };
    const res = await post({ ...valid, endpoint: 'https://169.254.169.254' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('private');
    expect(mockSet).not.toHaveBeenCalled();
    expect(insertedValues).toBeUndefined();
  });

  it('409s when the scope already has a backend', async () => {
    existingBackend = { id: 'be-1' };
    const res = await post(valid);
    expect(res.status).toBe(409);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('404s a workspace outside the caller\'s team', async () => {
    workspaceRow = undefined;
    const res = await post({ ...valid, workspaceId: WS });
    expect(res.status).toBe(404);
  });

  it('creates the backend, stores the credential as a secret, verifies, and returns 201', async () => {
    const res = await post(valid);
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(mockSet).toHaveBeenCalledTimes(1);
    const [id, value, meta] = mockSet.mock.calls[0];
    expect(id).toBeNull();
    expect(JSON.parse(value as string).secretAccessKey).toBe('shh-secret');
    expect(meta).toMatchObject({ teamId: TEAM, purpose: 'evidence_storage_credential' });
    expect(insertedValues).toMatchObject({ teamId: TEAM, workspaceId: null, credentialSecretId: 'sec-new', bucket: 'customer-bucket' });
    expect(mockVerify).toHaveBeenCalledWith('be-new');
    expect(json.verification.status).toBe('ok');
    expect(JSON.stringify(json)).not.toContain('shh-secret');
  });

  it('still saves when the verification probe fails', async () => {
    mockVerify.mockResolvedValueOnce({ backendId: 'be-new', status: 'failing', error: 'PUT failed', warnings: [], verifiedAt: 'now' } as any);
    const res = await post(valid);
    expect(res.status).toBe(201);
    expect((await res.json()).verification.status).toBe('failing');
  });

  it('creates a buildd_default backend with no credential and no endpoint check', async () => {
    const res = await post({ provider: 'buildd_default' });
    expect(res.status).toBe(201);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockValidate).not.toHaveBeenCalled();
    expect(insertedValues).toMatchObject({ provider: 'buildd_default', credentialSecretId: null, bucket: 'default-bucket' });
  });
});

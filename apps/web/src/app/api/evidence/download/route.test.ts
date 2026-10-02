import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import { S3Client } from '@aws-sdk/client-s3';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true as any));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

const mockTaskFindFirst = mock(() => Promise.resolve(null as any));
const mockObjFindFirst = mock((_args: any) => Promise.resolve(null as any));
const mockBackendFindFirst = mock((_args: any) => Promise.resolve(null as any));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTaskFindFirst },
      evidenceObjects: { findMany: mock(async () => []), findFirst: mockObjFindFirst },
      evidenceBackends: { findFirst: mockBackendFindFirst },
    },
  },
}));

// A real client with throwaway credentials: SigV4 presigning is local, so the
// URL the route returns is the one a browser would follow.
const realClient = new S3Client({
  region: 'us-east-1',
  endpoint: 'https://bucket-host.example.com',
  forcePathStyle: true,
  credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'test-secret-not-real' },
});
const mockGetEvidenceS3Client = mock(async (_row: any) => realClient);
mock.module('@/lib/evidence-backend', () => ({ getEvidenceS3Client: mockGetEvidenceS3Client }));
mock.module('@/lib/storage', () => ({ getDefaultStorageClient: () => realClient }));

const { GET } = await import('./route');
const { EVIDENCE_DOWNLOAD_EXPIRY_SECONDS } = await import('@/lib/evidence-read');

const TASK = 'abcdef12-3456-4789-8abc-def012345678';
const OTHER_TASK = 'bbbbbbbb-3456-4789-8abc-def012345678';
const EV = 'eeeeeeee-1111-4222-8333-444444444444';
const BACKEND = 'dddddddd-1111-4222-8333-444444444444';
const dialect = new PgDialect();

function req(q: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000/api/evidence/download?${q}`, { headers });
}
const both = `taskId=${TASK}&evidenceId=${EV}`;

function obj(over: Record<string, unknown> = {}) {
  return {
    id: EV, workspaceId: 'ws-mine', taskId: TASK, rootTaskId: TASK, workerId: 'w-1', prNumber: null,
    kind: 'command_output', backendId: BACKEND, objectKey: 'evidence/ws/root/task/w/command_output/1-0.log.gz',
    bytes: 10, sha256: null, uploadState: 'stored', indexState: 'skipped', expiresAt: null,
    createdAt: new Date('2026-09-30T00:00:00Z'), updatedAt: new Date('2026-09-30T00:00:00Z'),
    ...over,
  };
}

describe('GET /api/evidence/download', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1' });
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockImplementation(async (_u: string, ws: string) =>
      ws === 'ws-mine' ? { teamId: 't', role: 'member' } : null);
    mockTaskFindFirst.mockReset();
    mockTaskFindFirst.mockResolvedValue({ id: TASK, workspaceId: 'ws-mine' });
    mockObjFindFirst.mockReset();
    mockObjFindFirst.mockResolvedValue(obj());
    mockBackendFindFirst.mockReset();
    mockBackendFindFirst.mockResolvedValue({ id: BACKEND, provider: 's3', bucket: 'team-bucket' });
    mockGetEvidenceS3Client.mockClear();
  });

  it('401s with no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(req(both));
    expect(res.status).toBe(401);
    expect(mockObjFindFirst).not.toHaveBeenCalled();
  });

  it('401s an API key: downloads are dashboard-only, the key is never even looked up', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(req(both, { authorization: 'Bearer bld_test_key' }));
    expect(res.status).toBe(401);
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
    expect(mockTaskFindFirst).not.toHaveBeenCalled();
  });

  it('400s without full UUIDs', async () => {
    expect((await GET(req(`taskId=${TASK}`))).status).toBe(400);
    expect((await GET(req(`taskId=abcdef12&evidenceId=${EV}`))).status).toBe(400);
    expect((await GET(req(`taskId=${TASK}&evidenceId=nope`))).status).toBe(400);
  });

  it('404s a task in a workspace the caller cannot access, before touching evidence', async () => {
    mockTaskFindFirst.mockResolvedValue({ id: TASK, workspaceId: 'ws-other' });
    const res = await GET(req(both));
    expect(res.status).toBe(404);
    expect(mockObjFindFirst).not.toHaveBeenCalled();
    expect(mockGetEvidenceS3Client).not.toHaveBeenCalled();
  });

  it('404s a task that does not exist', async () => {
    mockTaskFindFirst.mockResolvedValue(null);
    expect((await GET(req(both))).status).toBe(404);
  });

  it('404s evidence that is not this task\'s', async () => {
    mockObjFindFirst.mockResolvedValue(null);
    const res = await GET(req(both));
    expect(res.status).toBe(404);
    expect(mockGetEvidenceS3Client).not.toHaveBeenCalled();
  });

  it('scopes the lookup by evidence id, workspace and task lineage', async () => {
    await GET(req(both));
    const q = dialect.sqlToQuery(mockObjFindFirst.mock.calls[0][0].where);
    expect(q.sql).toContain('"task_id" = ');
    expect(q.sql).toContain('"root_task_id" = ');
    expect(q.params).toContain(EV);
    expect(q.params).toContain(TASK);
    expect(q.params).toContain('ws-mine');
  });

  it('refuses a lineage mismatch even if the db returned the row', async () => {
    mockObjFindFirst.mockResolvedValue(obj({ taskId: OTHER_TASK, rootTaskId: OTHER_TASK }));
    const res = await GET(req(both));
    expect(res.status).toBe(404);
    expect(mockGetEvidenceS3Client).not.toHaveBeenCalled();
  });

  it('refuses a row from another workspace even if the db returned it', async () => {
    mockObjFindFirst.mockResolvedValue(obj({ workspaceId: 'ws-other' }));
    expect((await GET(req(both))).status).toBe(404);
  });

  for (const state of ['pending', 'failed', 'unreadable']) {
    it(`409s a ${state} object without signing anything`, async () => {
      mockObjFindFirst.mockResolvedValue(obj({ uploadState: state }));
      const res = await GET(req(both));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain(state);
      expect(body.url).toBeUndefined();
      expect(mockGetEvidenceS3Client).not.toHaveBeenCalled();
    });
  }

  it('mints a short-lived GET on the row\'s own backend, never cached', async () => {
    const before = Date.now();
    const res = await GET(req(both));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json();

    const url = new URL(body.url);
    expect(url.host).toBe('bucket-host.example.com');
    expect(url.pathname).toBe('/team-bucket/evidence/ws/root/task/w/command_output/1-0.log.gz');
    const expires = Number(url.searchParams.get('X-Amz-Expires'));
    expect(expires).toBeGreaterThan(0);
    expect(expires).toBeLessThanOrEqual(10 * 60);
    expect(expires).toBe(EVIDENCE_DOWNLOAD_EXPIRY_SECONDS);
    expect(url.searchParams.get('response-content-disposition')).toContain('attachment');
    expect(body.url).not.toContain('test-secret-not-real');

    const expiresAt = new Date(body.expiresAt).getTime();
    expect(expiresAt - before).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    expect(body.filename).toBe('command_output-1-0.log.gz');

    expect(mockBackendFindFirst).toHaveBeenCalledTimes(1);
    expect(mockGetEvidenceS3Client.mock.calls[0][0].id).toBe(BACKEND);
  });

  it('mints a fresh URL on every click', async () => {
    const a = await (await GET(req(both))).json();
    await new Promise(r => setTimeout(r, 1100));
    const b = await (await GET(req(both))).json();
    expect(a.url).not.toBe(b.url);
  });

  it('410s when the object\'s backend was removed', async () => {
    mockBackendFindFirst.mockResolvedValue(null);
    const res = await GET(req(both));
    expect(res.status).toBe(410);
  });
});

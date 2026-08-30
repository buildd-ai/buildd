import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => ({ dataClass: 'standard' }) as any);
const mockInsertValues = mock((vals: any) => ({
  returning: mock(() => [{ id: 'artifact-1', ...vals }]),
}));
const mockGenerateSizedUploadUrl = mock(() => Promise.resolve('https://r2.example/signed'));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/storage', () => ({
  isStorageConfigured: () => true,
  generateSizedUploadUrl: mockGenerateSizedUploadUrl,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: () => ({ values: mockInsertValues }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  artifacts: 'artifacts',
  workspaces: 'workspaces',
}));

mock.module('@buildd/shared', () => ({
  ArtifactType: { FILE: 'file' },
}));

mock.module('crypto', () => ({
  randomBytes: () => ({ toString: () => 'share-token' }),
  randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
}));

const { POST, MAX_ARTIFACT_UPLOAD_BYTES } = await import('./route');

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function req(body: any, apiKey = 'bld_test'): NextRequest {
  return new NextRequest('http://localhost:3000/api/artifacts/upload-url', {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    }),
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    workerId: 'worker-1',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    ...overrides,
  };
}

describe('POST /api/artifacts/upload-url', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockInsertValues.mockClear();
    mockGenerateSizedUploadUrl.mockClear();

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' } as any);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      workspaceId: 'ws-1',
    } as any);
    mockWorkspacesFindFirst.mockResolvedValue({ dataClass: 'standard' } as any);
  });

  it('signs a key under the worker workspace prefix', async () => {
    const res = await POST(req(validBody()));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.storageKey).toBe(`artifacts/ws-1/${UUID}/report.pdf`);
    expect(mockGenerateSizedUploadUrl).toHaveBeenCalledWith(
      `artifacts/ws-1/${UUID}/report.pdf`,
      'application/pdf',
      1024,
    );
  });

  it('does not let the supplied name change the shape of the key', async () => {
    for (const filename of ['../../probe.txt', 'a/b/c.txt', '/etc/passwd', '..']) {
      mockGenerateSizedUploadUrl.mockClear();
      const res = await POST(req(validBody({ filename })));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.storageKey.split('/')).toHaveLength(4);
      expect(data.storageKey.startsWith(`artifacts/ws-1/${UUID}/`)).toBe(true);
      expect(data.storageKey).not.toContain('..');
      // The signer must receive the same key that was recorded.
      expect(mockGenerateSizedUploadUrl.mock.calls[0][0]).toBe(data.storageKey);
    }
  });

  it('records the caller name verbatim in metadata and title', async () => {
    const filename = 'Quarterly Report (final)/v2.pdf';
    const res = await POST(req(validBody({ filename })));
    expect(res.status).toBe(200);

    const values = mockInsertValues.mock.calls[0][0] as any;
    expect(values.metadata.filename).toBe(filename);
    expect(values.title).toBe(filename);
    const segments = values.storageKey.split('/');
    expect(segments).toHaveLength(4);
    expect(segments[3]).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('rejects a declared size above the ceiling with 413', async () => {
    const res = await POST(req(validBody({ sizeBytes: MAX_ARTIFACT_UPLOAD_BYTES + 1 })));
    expect(res.status).toBe(413);
    expect(mockGenerateSizedUploadUrl).not.toHaveBeenCalled();
  });

  it('accepts a declared size exactly at the ceiling', async () => {
    const res = await POST(req(validBody({ sizeBytes: MAX_ARTIFACT_UPLOAD_BYTES })));
    expect(res.status).toBe(200);
  });

  it('rejects a declared size that is not a positive integer', async () => {
    for (const sizeBytes of [0, -1, 1.5, 'big', null]) {
      const res = await POST(req(validBody({ sizeBytes })));
      expect(res.status).toBe(400);
    }
    expect(mockGenerateSizedUploadUrl).not.toHaveBeenCalled();
  });

  it('still enforces auth, worker ownership and sensitive-workspace blocking', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null as any);
    expect((await POST(req(validBody(), ''))).status).toBe(401);

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' } as any);
    mockWorkersFindFirst.mockResolvedValue(null as any);
    expect((await POST(req(validBody()))).status).toBe(404);

    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'other-account',
      workspaceId: 'ws-1',
    } as any);
    expect((await POST(req(validBody()))).status).toBe(403);

    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      workspaceId: 'ws-1',
    } as any);
    mockWorkspacesFindFirst.mockResolvedValue({ dataClass: 'sensitive' } as any);
    expect((await POST(req(validBody()))).status).toBe(403);

    expect(mockGenerateSizedUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses to sign when the worker has no workspace to scope the key to', async () => {
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      workspaceId: null,
    } as any);
    const res = await POST(req(validBody()));
    expect(res.status).toBe(400);
    expect(mockGenerateSizedUploadUrl).not.toHaveBeenCalled();
  });
});

/**
 * Audit regression for the pre-existing artifacts presign route.
 *
 * The route already derived the key prefix server-side (`artifacts/<workspaceId>/<uuid>/`)
 * and already refused sensitive workspaces — but it appended the CLIENT-SUPPLIED
 * `filename` verbatim. `../../role-configs/bundle.zip` therefore produced a key
 * containing `..`, which URL path normalisation collapses on the way to R2, letting
 * a compromised runner or agent target objects outside its own prefix.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/app/api/artifacts/upload-url/route.test.ts
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockGenerateUploadUrl = mock((..._args: any[]) => Promise.resolve('https://storage.example.invalid/signed'));
const mockInsertValues = mock((..._args: any[]) => ({
  returning: async () => [{ id: 'artifact-1' }],
}));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));

mock.module('@/lib/storage', () => ({
  isStorageConfigured: () => true,
  generateUploadUrl: mockGenerateUploadUrl,
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
  workers: { id: 'workers.id' },
  workspaces: { id: 'workspaces.id' },
  artifacts: 'artifacts',
}));

import { POST } from './route';

function req(body: any): NextRequest {
  return new NextRequest('http://localhost:3000/api/artifacts/upload-url', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_test_key' }),
    body: JSON.stringify(body),
  });
}

function baseBody(filename: string) {
  return { workerId: WORKER, filename, mimeType: 'application/zip', sizeBytes: 10 };
}

describe('POST /api/artifacts/upload-url — key derivation', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGenerateUploadUrl.mockReset();
    mockInsertValues.mockReset();

    mockAuthenticateApiKey.mockResolvedValue({ id: ACCOUNT });
    mockWorkersFindFirst.mockResolvedValue({ id: WORKER, accountId: ACCOUNT, workspaceId: WORKSPACE });
    mockWorkspacesFindFirst.mockResolvedValue({ dataClass: 'standard' });
    mockGenerateUploadUrl.mockResolvedValue('https://storage.example.invalid/signed');
    mockInsertValues.mockReturnValue({ returning: async () => [{ id: 'artifact-1' }] });
  });

  it('keeps a well-behaved filename intact', async () => {
    const res = await POST(req(baseBody('report.zip')));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.storageKey.startsWith(`artifacts/${WORKSPACE}/`)).toBe(true);
    expect(json.storageKey.endsWith('/report.zip')).toBe(true);
  });

  it('strips path traversal out of the client-supplied filename', async () => {
    const res = await POST(req(baseBody('../../role-configs/bundle.zip')));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.storageKey).not.toContain('..');
    expect(json.storageKey).not.toContain('role-configs');
    expect(json.storageKey.startsWith(`artifacts/${WORKSPACE}/`)).toBe(true);
    expect(mockGenerateUploadUrl.mock.calls[0][0]).toBe(json.storageKey);
  });

  it('strips absolute paths and nested separators', async () => {
    const res = await POST(req(baseBody('/etc/passwd')));
    const json = await res.json();
    expect(json.storageKey.startsWith(`artifacts/${WORKSPACE}/`)).toBe(true);
    expect(json.storageKey).not.toContain('/etc/');
  });

  it('never yields an empty final segment', async () => {
    const res = await POST(req(baseBody('../')));
    const json = await res.json();
    const segments = json.storageKey.split('/');
    expect(segments[segments.length - 1].length).toBeGreaterThan(0);
    expect(json.storageKey).not.toContain('..');
  });

  it('still refuses sensitive workspaces', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ dataClass: 'sensitive' });
    const res = await POST(req(baseBody('report.zip')));
    expect(res.status).toBe(403);
    expect(mockGenerateUploadUrl).not.toHaveBeenCalled();
  });
});

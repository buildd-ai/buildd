import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockIsStorageConfigured = mock(() => true);
const mockGenerateConstrainedUploadUrl = mock(
  (..._args: any[]) => Promise.resolve('https://storage.example.invalid/signed') as Promise<string>
);
const mockObjectExists = mock((..._args: any[]) => Promise.resolve(false) as Promise<boolean>);

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/storage', () => ({
  isStorageConfigured: mockIsStorageConfigured,
  generateConstrainedUploadUrl: mockGenerateConstrainedUploadUrl,
  objectExists: mockObjectExists,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'workers.id' },
}));

import { POST } from './route';
import { MAX_SESSION_ARTIFACT_BYTES } from '@/lib/session-artifact-keys';

const mockParams = Promise.resolve({ id: WORKER });

function req(body?: any, apiKey = 'bld_test_key_value'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest(`http://localhost:3000/api/workers/${WORKER}/session-upload-url`, {
    method: 'POST',
    headers: new Headers(headers),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function standardWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKER,
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    workspace: { teamId: TEAM, dataClass: 'standard' },
    ...overrides,
  };
}

describe('POST /api/workers/[id]/session-upload-url', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockIsStorageConfigured.mockReset();
    mockGenerateConstrainedUploadUrl.mockReset();
    mockObjectExists.mockReset();

    mockIsStorageConfigured.mockReturnValue(true);
    mockGenerateConstrainedUploadUrl.mockResolvedValue('https://storage.example.invalid/signed');
    mockObjectExists.mockResolvedValue(false);
    mockAuthenticateApiKey.mockResolvedValue({ id: ACCOUNT, teamId: TEAM });
    mockWorkersFindFirst.mockResolvedValue(standardWorker());
  });

  it('returns 401 without a valid API key and never signs', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(req({ kind: 'transcript', sizeBytes: 100 }), { params: mockParams });
    expect(res.status).toBe(401);
    expect(mockGenerateConstrainedUploadUrl).not.toHaveBeenCalled();
  });

  it('derives the key server-side and ignores a client-supplied key', async () => {
    const res = await POST(
      req({
        kind: 'transcript',
        sizeBytes: 512,
        key: 'role-configs/victim/bundle.zip',
        storageKey: 'artifacts/other-tenant/steal.json',
      }),
      { params: mockParams }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.storageKey).toBe(`sessions/${TEAM}/${WORKSPACE}/${WORKER}/transcript.jsonl`);
    expect(json.storageKey).not.toContain('role-configs');
    expect(json.storageKey).not.toContain('artifacts/');
    const signedKey = mockGenerateConstrainedUploadUrl.mock.calls[0][0];
    expect(signedKey).toBe(`sessions/${TEAM}/${WORKSPACE}/${WORKER}/transcript.jsonl`);
  });

  it('returns 403 without signing when the API key does not own the worker', async () => {
    mockWorkersFindFirst.mockResolvedValue(standardWorker({ accountId: 'someone-elses-account' }));
    const res = await POST(req({ kind: 'transcript', sizeBytes: 100 }), { params: mockParams });
    expect(res.status).toBe(403);
    expect(mockGenerateConstrainedUploadUrl).not.toHaveBeenCalled();
  });

  it('returns 403 without signing when the worker team does not match the caller team', async () => {
    mockWorkersFindFirst.mockResolvedValue(
      standardWorker({ workspace: { teamId: 'another-team', dataClass: 'standard' } })
    );
    const res = await POST(req({ kind: 'transcript', sizeBytes: 100 }), { params: mockParams });
    expect(res.status).toBe(403);
    expect(mockGenerateConstrainedUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses a sensitive workspace at signing time', async () => {
    mockWorkersFindFirst.mockResolvedValue(
      standardWorker({ workspace: { teamId: TEAM, dataClass: 'sensitive' } })
    );
    const res = await POST(req({ kind: 'transcript', sizeBytes: 100 }), { params: mockParams });
    expect(res.status).toBe(403);
    expect(mockGenerateConstrainedUploadUrl).not.toHaveBeenCalled();
    const json = await res.json();
    expect(String(json.error)).toContain('sensitive');
  });

  it('caps the upload size inside the signature', async () => {
    await POST(req({ kind: 'transcript', sizeBytes: 4242 }), { params: mockParams });
    const [, contentType, contentLength] = mockGenerateConstrainedUploadUrl.mock.calls[0];
    expect(contentType).toBe('application/x-ndjson');
    expect(contentLength).toBe(4242);
  });

  it('rejects a size above the ceiling with 413 and never signs', async () => {
    const res = await POST(
      req({ kind: 'transcript', sizeBytes: MAX_SESSION_ARTIFACT_BYTES + 1 }),
      { params: mockParams }
    );
    expect(res.status).toBe(413);
    expect(mockGenerateConstrainedUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects a non-positive or non-integer size', async () => {
    expect((await POST(req({ kind: 'transcript', sizeBytes: 0 }), { params: mockParams })).status).toBe(400);
    expect((await POST(req({ kind: 'transcript', sizeBytes: -5 }), { params: mockParams })).status).toBe(400);
    expect((await POST(req({ kind: 'transcript', sizeBytes: 1.5 }), { params: mockParams })).status).toBe(400);
    expect(mockGenerateConstrainedUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind', async () => {
    const res = await POST(req({ kind: 'role-config', sizeBytes: 100 }), { params: mockParams });
    expect(res.status).toBe(400);
    expect(mockGenerateConstrainedUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses to re-sign an object that already exists (write-once)', async () => {
    mockObjectExists.mockResolvedValue(true);
    const res = await POST(req({ kind: 'transcript', sizeBytes: 100 }), { params: mockParams });
    expect(res.status).toBe(409);
    expect(mockGenerateConstrainedUploadUrl).not.toHaveBeenCalled();
  });

  it('fails closed (no signature) when the write-once check itself errors', async () => {
    mockObjectExists.mockRejectedValue(new Error('r2 unreachable'));
    const res = await POST(req({ kind: 'transcript', sizeBytes: 100 }), { params: mockParams });
    expect(res.status).toBe(503);
    expect(mockGenerateConstrainedUploadUrl).not.toHaveBeenCalled();
  });

  it('returns 503 when storage is not configured', async () => {
    mockIsStorageConfigured.mockReturnValue(false);
    const res = await POST(req({ kind: 'transcript', sizeBytes: 100 }), { params: mockParams });
    expect(res.status).toBe(503);
    expect(mockWorkersFindFirst).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown worker', async () => {
    mockWorkersFindFirst.mockResolvedValue(null);
    const res = await POST(req({ kind: 'transcript', sizeBytes: 100 }), { params: mockParams });
    expect(res.status).toBe(404);
    expect(mockGenerateConstrainedUploadUrl).not.toHaveBeenCalled();
  });

  it('adds exactly one authorization SELECT and no other Neon traffic', async () => {
    await POST(req({ kind: 'session-log', sizeBytes: 100 }), { params: mockParams });
    expect(mockWorkersFindFirst).toHaveBeenCalledTimes(1);
    // dataClass + teamId come from the same relational query — no second round trip.
    const arg = mockWorkersFindFirst.mock.calls[0][0] as any;
    expect(arg.with?.workspace).toBeDefined();
  });
});

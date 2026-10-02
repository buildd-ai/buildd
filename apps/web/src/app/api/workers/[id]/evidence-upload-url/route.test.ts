import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const TASK = '55555555-5555-4555-8555-555555555555';
const ROOT_TASK = '66666666-6666-4666-8666-666666666666';
const BACKEND = '77777777-7777-4777-8777-777777777777';

// A credential value the route must never echo, however it is wired.
const SECRET_ACCESS_KEY = 'evidence-secret-access-key-value';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock((..._args: any[]) => null as any);
const mockResolveEvidenceBackend = mock((..._args: any[]) => null as any);
const mockGenerateEvidenceUploadUrl = mock(
  (..._args: any[]) => Promise.resolve('https://bucket.example.invalid/signed') as Promise<string>
);
const mockSumBytes = mock(() => Promise.resolve([{ total: 0 }]) as Promise<any[]>);
const inserted: any[] = [];
const mockInsertReturning = mock(() => Promise.resolve([{ id: 'ev-1' }]) as Promise<any[]>);

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/evidence-backend', () => ({
  resolveEvidenceBackend: mockResolveEvidenceBackend,
  generateEvidenceUploadUrl: mockGenerateEvidenceUploadUrl,
  EVIDENCE_UPLOAD_EXPIRY_SECONDS: 900,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
    },
    select: () => ({ from: () => ({ where: mockSumBytes }) }),
    insert: () => ({
      values: (v: any) => {
        inserted.push(v);
        return { returning: mockInsertReturning };
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  ne: (field: any, value: any) => ({ field, value, type: 'ne' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { id: 'accounts.id' },
  workers: { id: 'workers.id' },
  tasks: { id: 'tasks.id' },
  evidenceObjects: {
    id: 'evidence_objects.id',
    taskId: 'evidence_objects.task_id',
    bytes: 'evidence_objects.bytes',
    uploadState: 'evidence_objects.upload_state',
  },
}));

import { POST } from './route';

const mockParams = Promise.resolve({ id: WORKER });

function req(body?: any, apiKey = 'bld_test_key_value'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest(`http://localhost:3000/api/workers/${WORKER}/evidence-upload-url`, {
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
    taskId: TASK,
    workspace: { teamId: TEAM, dataClass: 'standard' },
    ...overrides,
  };
}

function backend(overrides: Record<string, unknown> = {}) {
  return {
    source: 'buildd_default',
    backendId: null,
    teamId: TEAM,
    workspaceId: null,
    provider: 'buildd_default',
    bucket: 'default-bucket',
    endpoint: null,
    region: null,
    prefix: 'evidence',
    forcePathStyle: true,
    sse: 'none',
    kmsKeyId: null,
    retentionDays: 30,
    maxBytesPerTask: 1000,
    status: 'ok',
    usable: true,
    problem: null,
    ...overrides,
  };
}

const byo = (o: Record<string, unknown> = {}) =>
  backend({ source: 'team', backendId: BACKEND, provider: 's3', bucket: 'customer-bucket', prefix: 'team-evidence', ...o });

const ok = { kind: 'command_output', seq: 3, sizeBytes: 100 };

describe('POST /api/workers/[id]/evidence-upload-url', () => {
  beforeEach(() => {
    for (const m of [mockAuthenticateApiKey, mockWorkersFindFirst, mockTasksFindFirst, mockResolveEvidenceBackend,
      mockGenerateEvidenceUploadUrl, mockSumBytes, mockInsertReturning]) m.mockReset();
    inserted.length = 0;

    mockAuthenticateApiKey.mockResolvedValue({ id: ACCOUNT, teamId: TEAM });
    mockWorkersFindFirst.mockResolvedValue(standardWorker());
    // TASK's parent is ROOT_TASK, which has no parent.
    mockTasksFindFirst.mockImplementation(async ({ where }: any) =>
      where.value === TASK ? { id: TASK, parentTaskId: ROOT_TASK } : { id: ROOT_TASK, parentTaskId: null });
    mockResolveEvidenceBackend.mockResolvedValue(backend());
    mockGenerateEvidenceUploadUrl.mockResolvedValue('https://bucket.example.invalid/signed');
    mockSumBytes.mockResolvedValue([{ total: 0 }]);
    mockInsertReturning.mockResolvedValue([{ id: 'ev-1' }]);
  });

  it('returns 401 without a valid API key and never signs', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(req(ok), { params: mockParams });
    expect(res.status).toBe(401);
    expect(mockGenerateEvidenceUploadUrl).not.toHaveBeenCalled();
  });

  it('returns 404 for a non-UUID worker id without querying', async () => {
    const res = await POST(req(ok), { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(404);
    expect(mockWorkersFindFirst).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown worker', async () => {
    mockWorkersFindFirst.mockResolvedValue(null);
    const res = await POST(req(ok), { params: mockParams });
    expect(res.status).toBe(404);
    expect(mockGenerateEvidenceUploadUrl).not.toHaveBeenCalled();
  });

  it('returns 403 when the API key does not own the worker', async () => {
    mockWorkersFindFirst.mockResolvedValue(standardWorker({ accountId: 'someone-else' }));
    const res = await POST(req(ok), { params: mockParams });
    expect(res.status).toBe(403);
    expect(mockGenerateEvidenceUploadUrl).not.toHaveBeenCalled();
  });

  it('passes the request to auth, so a scoped token is checked against this route', async () => {
    await POST(req(ok), { params: mockParams });
    const [, request] = mockAuthenticateApiKey.mock.calls[0] as any[];
    expect(request?.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe(`/api/workers/${WORKER}/evidence-upload-url`);
  });

  it("a per-task token signs for its own worker, never the same account's worker on another task", async () => {
    const scoped = (taskId: string) => ({
      id: ACCOUNT, teamId: TEAM, level: 'worker', taskScope: { taskId, workspaceId: WORKSPACE, expiresAt: Date.now() + 60_000 },
    });
    mockAuthenticateApiKey.mockResolvedValue(scoped(ROOT_TASK));
    expect((await POST(req(ok), { params: mockParams })).status).toBe(403);
    expect(mockGenerateEvidenceUploadUrl).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    mockAuthenticateApiKey.mockResolvedValue(scoped(TASK));
    expect((await POST(req(ok), { params: mockParams })).status).toBe(200);
    expect(inserted[0].taskId).toBe(TASK);
  });

  it('returns 403 when the worker team does not match the caller team', async () => {
    mockWorkersFindFirst.mockResolvedValue(standardWorker({ workspace: { teamId: 'another-team', dataClass: 'standard' } }));
    const res = await POST(req(ok), { params: mockParams });
    expect(res.status).toBe(403);
    expect(mockResolveEvidenceBackend).not.toHaveBeenCalled();
    expect(mockGenerateEvidenceUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses a sensitive workspace with no BYO backend (403)', async () => {
    mockWorkersFindFirst.mockResolvedValue(standardWorker({ workspace: { teamId: TEAM, dataClass: 'sensitive' } }));
    const res = await POST(req(ok), { params: mockParams });
    expect(res.status).toBe(403);
    expect(String((await res.json()).error)).toContain('sensitive');
    expect(mockGenerateEvidenceUploadUrl).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('refuses a sensitive workspace whose team row is buildd_default (not BYO)', async () => {
    mockWorkersFindFirst.mockResolvedValue(standardWorker({ workspace: { teamId: TEAM, dataClass: 'sensitive' } }));
    mockResolveEvidenceBackend.mockResolvedValue(backend({ source: 'team', backendId: BACKEND }));
    const res = await POST(req(ok), { params: mockParams });
    expect(res.status).toBe(403);
  });

  it('allows a sensitive workspace with a BYO backend and marks index_state skipped', async () => {
    mockWorkersFindFirst.mockResolvedValue(standardWorker({ workspace: { teamId: TEAM, dataClass: 'sensitive' } }));
    mockResolveEvidenceBackend.mockResolvedValue(byo());
    const res = await POST(req(ok), { params: mockParams });
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].indexState).toBe('skipped');
    expect(inserted[0].backendId).toBe(BACKEND);
  });

  it('rejects an upload that would push the task past max_bytes_per_task (413)', async () => {
    mockSumBytes.mockResolvedValue([{ total: 950 }]);
    const res = await POST(req({ ...ok, sizeBytes: 51 }), { params: mockParams });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.maxBytesPerTask).toBe(1000);
    expect(mockGenerateEvidenceUploadUrl).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('accepts an upload that lands exactly on the cap', async () => {
    mockSumBytes.mockResolvedValue([{ total: '950' }]); // bigint sums arrive as strings
    const res = await POST(req({ ...ok, sizeBytes: 50 }), { params: mockParams });
    expect(res.status).toBe(200);
  });

  it('counts the cap across the task, excluding failed uploads', async () => {
    await POST(req(ok), { params: mockParams });
    const where = (mockSumBytes.mock.calls[0] as any[])[0];
    expect(where.type).toBe('and');
    expect(where.args).toContainEqual({ field: 'evidence_objects.task_id', value: TASK, type: 'eq' });
    expect(where.args).toContainEqual({ field: 'evidence_objects.upload_state', value: 'failed', type: 'ne' });
  });

  it('signs a URL for the server-derived key, ignoring any body key, with the size bound in', async () => {
    const res = await POST(
      req({ ...ok, key: 'role-configs/victim/bundle.zip', storageKey: 'artifacts/other/x.json' }),
      { params: mockParams },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const expectedPrefix = `evidence/${WORKSPACE}/${ROOT_TASK}/${TASK}/${WORKER}/command_output/`;
    expect(json.uploadUrl).toBe('https://bucket.example.invalid/signed');
    expect(json.key.startsWith(expectedPrefix)).toBe(true);
    expect(json.key).toMatch(/\/\d+-3\.log\.gz$/);
    expect(json.key).not.toContain('role-configs');
    expect(json.evidenceId).toBe('ev-1');
    expect(json.expiresIn).toBe(900);

    const [signedBackend, signedKey, signedSize] = mockGenerateEvidenceUploadUrl.mock.calls[0];
    expect(signedBackend.provider).toBe('buildd_default');
    expect(signedKey).toBe(json.key);
    expect(signedSize).toBe(100);

    expect(inserted[0]).toMatchObject({
      workspaceId: WORKSPACE, taskId: TASK, rootTaskId: ROOT_TASK, workerId: WORKER,
      kind: 'command_output', objectKey: json.key, bytes: 100, uploadState: 'pending', indexState: 'queued',
    });
    expect(inserted[0].expiresAt).toBeInstanceOf(Date);
  });

  it('uses the backend prefix and a jsonl extension for transcripts', async () => {
    mockResolveEvidenceBackend.mockResolvedValue(byo());
    const res = await POST(req({ kind: 'transcript', seq: 0, sizeBytes: 10 }), { params: mockParams });
    const json = await res.json();
    expect(json.key.startsWith(`team-evidence/${WORKSPACE}/`)).toBe(true);
    expect(json.key).toMatch(/\/\d+-0\.jsonl\.gz$/);
  });

  it('accepts a runner-written test_report and keys it as .log.gz under test_report/', async () => {
    const res = await POST(req({ kind: 'test_report', seq: 1, sizeBytes: 10 }), { params: mockParams });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.key.startsWith(`evidence/${WORKSPACE}/${ROOT_TASK}/${TASK}/${WORKER}/test_report/`)).toBe(true);
    expect(json.key).toMatch(/\/test_report\/\d+-1\.log\.gz$/);
    expect(inserted[0].kind).toBe('test_report');
  });

  it('looks the worker up by the path worker id, once', async () => {
    await POST(req(ok), { params: mockParams });
    expect(mockWorkersFindFirst).toHaveBeenCalledTimes(1);
    const arg = (mockWorkersFindFirst.mock.calls[0] as any[])[0];
    expect(arg.where).toEqual({ field: 'workers.id', value: WORKER, type: 'eq' });
    expect(arg.with?.workspace).toBeDefined();
  });

  it('uses the task itself as root when it has no parent', async () => {
    mockTasksFindFirst.mockResolvedValue({ id: TASK, parentTaskId: null });
    const json = await (await POST(req(ok), { params: mockParams })).json();
    expect(json.key).toContain(`/${TASK}/${TASK}/`);
  });

  it('never returns a credential value (AC-9)', async () => {
    mockResolveEvidenceBackend.mockResolvedValue(byo({ credentialSecretId: 'sec-1', secretAccessKey: SECRET_ACCESS_KEY }));
    const res = await POST(req(ok), { params: mockParams });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(SECRET_ACCESS_KEY);
    expect(text).not.toContain('sec-1');
    expect(text).not.toContain('customer-bucket');
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['contentLength', 'evidenceId', 'expiresIn', 'key', 'uploadUrl']);
  });

  it('rejects an unknown or server-only kind', async () => {
    for (const kind of ['role-config', 'ci_job_log', 'pr_diff', '../x']) {
      const res = await POST(req({ ...ok, kind }), { params: mockParams });
      expect(res.status).toBe(400);
    }
    expect(mockGenerateEvidenceUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects a bad seq or sizeBytes', async () => {
    for (const body of [
      { ...ok, seq: -1 }, { ...ok, seq: 1.5 }, { ...ok, seq: '1' },
      { ...ok, sizeBytes: 0 }, { ...ok, sizeBytes: -5 }, { ...ok, sizeBytes: 1.5 },
    ]) {
      expect((await POST(req(body), { params: mockParams })).status).toBe(400);
    }
    expect(mockGenerateEvidenceUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses (not 5xx) when the worker has no task', async () => {
    mockWorkersFindFirst.mockResolvedValue(standardWorker({ taskId: null }));
    const res = await POST(req(ok), { params: mockParams });
    expect(res.status).toBe(409);
  });

  describe('storage failures are refusals, never 5xx', () => {
    it('backend resolution throws', async () => {
      mockResolveEvidenceBackend.mockRejectedValue(new Error('db down'));
      const res = await POST(req(ok), { params: mockParams });
      expect(res.status).toBe(424);
    });

    it('backend is unusable', async () => {
      mockResolveEvidenceBackend.mockResolvedValue(byo({ usable: false, problem: 'no credential is set for this backend' }));
      const res = await POST(req(ok), { params: mockParams });
      expect(res.status).toBe(424);
      expect(mockGenerateEvidenceUploadUrl).not.toHaveBeenCalled();
    });

    it('signing throws', async () => {
      mockGenerateEvidenceUploadUrl.mockRejectedValue(new Error(`bad creds ${SECRET_ACCESS_KEY}`));
      const res = await POST(req(ok), { params: mockParams });
      expect(res.status).toBe(424);
      expect(await res.text()).not.toContain(SECRET_ACCESS_KEY);
      expect(inserted).toHaveLength(0);
    });

    it('the pointer insert throws', async () => {
      mockInsertReturning.mockRejectedValue(new Error('insert failed'));
      const res = await POST(req(ok), { params: mockParams });
      expect(res.status).toBe(424);
    });

    it('the cap query throws', async () => {
      mockSumBytes.mockRejectedValue(new Error('timeout'));
      const res = await POST(req(ok), { params: mockParams });
      expect(res.status).toBe(424);
      expect(mockGenerateEvidenceUploadUrl).not.toHaveBeenCalled();
    });
  });
});

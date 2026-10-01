import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const EVIDENCE = '88888888-8888-4888-8888-888888888888';
const OTHER_WORKER = '99999999-9999-4999-8999-999999999999';
const TASK = '55555555-5555-4555-8555-555555555555';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock((_args: any) => null as any);
const mockEvidenceFindFirst = mock((_args: any) => null as any);
const mockConfirm = mock((_row: any) => Promise.resolve({ uploadState: 'stored', bytes: 120, changed: true }) as Promise<any>);

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/evidence-confirm', () => ({ confirmEvidenceUpload: mockConfirm }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      evidenceObjects: { findFirst: mockEvidenceFindFirst },
    },
  },
}));

import { POST } from './route';

const dialect = new PgDialect();
const params = (id = WORKER, evidenceId = EVIDENCE) => ({ params: Promise.resolve({ id, evidenceId }) });

function req(apiKey: string | null = 'bld_test_key_value'): NextRequest {
  const headers: Record<string, string> = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest(`http://localhost:3000/api/workers/${WORKER}/evidence/${EVIDENCE}/confirm`, {
    method: 'POST',
    headers: new Headers(headers),
  });
}

function worker(over: Record<string, unknown> = {}) {
  return { id: WORKER, accountId: ACCOUNT, workspaceId: WORKSPACE, taskId: TASK, workspace: { teamId: TEAM }, ...over };
}

function evidence(over: Record<string, unknown> = {}) {
  return {
    id: EVIDENCE, workspaceId: WORKSPACE, workerId: WORKER, taskId: 't', rootTaskId: 't',
    objectKey: 'evidence/k/1-0.log.gz', bytes: 120, uploadState: 'pending', indexState: 'queued', backendId: null,
    ...over,
  };
}

describe('POST /api/workers/[id]/evidence/[evidenceId]/confirm', () => {
  beforeEach(() => {
    for (const m of [mockAuthenticateApiKey, mockWorkersFindFirst, mockEvidenceFindFirst, mockConfirm]) m.mockReset();
    mockAuthenticateApiKey.mockResolvedValue({ id: ACCOUNT, teamId: TEAM });
    mockWorkersFindFirst.mockResolvedValue(worker());
    mockEvidenceFindFirst.mockResolvedValue(evidence());
    mockConfirm.mockResolvedValue({ uploadState: 'stored', bytes: 120, changed: true });
  });

  it('returns 401 without a valid API key and never checks the bucket', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(req(null), params());
    expect(res.status).toBe(401);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('returns 404 for a non-UUID worker or evidence id without querying', async () => {
    expect((await POST(req(), params('nope'))).status).toBe(404);
    expect((await POST(req(), params(WORKER, 'nope'))).status).toBe(404);
    expect(mockWorkersFindFirst).not.toHaveBeenCalled();
    expect(mockEvidenceFindFirst).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown worker', async () => {
    mockWorkersFindFirst.mockResolvedValue(null);
    expect((await POST(req(), params())).status).toBe(404);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('returns 403 when the API key does not own the worker', async () => {
    mockWorkersFindFirst.mockResolvedValue(worker({ accountId: 'someone-else' }));
    expect((await POST(req(), params())).status).toBe(403);
    expect(mockEvidenceFindFirst).not.toHaveBeenCalled();
  });

  it('passes the request to auth, so a scoped token is checked against this route', async () => {
    await POST(req(), params());
    const [, request] = mockAuthenticateApiKey.mock.calls[0] as any[];
    expect(request?.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe(`/api/workers/${WORKER}/evidence/${EVIDENCE}/confirm`);
  });

  it("a per-task token confirms its own worker's evidence, never the same account's worker on another task", async () => {
    const scoped = (taskId: string) => ({
      id: ACCOUNT, teamId: TEAM, level: 'worker', taskScope: { taskId, workspaceId: WORKSPACE, expiresAt: Date.now() + 60_000 },
    });
    mockAuthenticateApiKey.mockResolvedValue(scoped('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
    expect((await POST(req(), params())).status).toBe(403);
    expect(mockEvidenceFindFirst).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    mockAuthenticateApiKey.mockResolvedValue(scoped(TASK));
    expect((await POST(req(), params())).status).toBe(200);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('returns 403 when the worker team does not match the caller team', async () => {
    mockWorkersFindFirst.mockResolvedValue(worker({ workspace: { teamId: 'another-team' } }));
    expect((await POST(req(), params())).status).toBe(403);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('scopes the evidence lookup to this worker', async () => {
    await POST(req(), params());
    const q = dialect.sqlToQuery(mockEvidenceFindFirst.mock.calls[0][0].where);
    expect(q.sql).toContain('"worker_id" = ');
    expect(q.params).toContain(EVIDENCE);
    expect(q.params).toContain(WORKER);
    const w = mockWorkersFindFirst.mock.calls[0][0];
    expect(dialect.sqlToQuery(w.where).params).toEqual([WORKER]);
  });

  it('returns 404 for an evidence id that belongs to another worker, even if the db returned it', async () => {
    mockEvidenceFindFirst.mockResolvedValue(evidence({ workerId: OTHER_WORKER }));
    const res = await POST(req(), params());
    expect(res.status).toBe(404);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown evidence id', async () => {
    mockEvidenceFindFirst.mockResolvedValue(undefined);
    expect((await POST(req(), params())).status).toBe(404);
  });

  it('confirms a pending row and reports it stored', async () => {
    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ evidenceId: EVIDENCE, uploadState: 'stored', bytes: 120 });
    expect(mockConfirm.mock.calls[0][0].id).toBe(EVIDENCE);
  });

  it('reports a missing object as failed with 200 (a decision, not an error)', async () => {
    mockConfirm.mockResolvedValue({ uploadState: 'failed', bytes: 120, changed: true, reason: 'the object was never uploaded' });
    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ evidenceId: EVIDENCE, uploadState: 'failed', bytes: 120, reason: 'the object was never uploaded' });
  });

  it('reports a size mismatch as failed', async () => {
    mockConfirm.mockResolvedValue({ uploadState: 'failed', bytes: 120, changed: true, reason: 'the stored object is 999 bytes, not the signed 120' });
    const json = await (await POST(req(), params())).json();
    expect(json.uploadState).toBe('failed');
    expect(json.reason).toContain('999');
  });

  it('is idempotent: a second confirm returns the same state', async () => {
    mockConfirm.mockResolvedValueOnce({ uploadState: 'stored', bytes: 120, changed: true });
    mockConfirm.mockResolvedValueOnce({ uploadState: 'stored', bytes: 120, changed: false });
    const first = await (await POST(req(), params())).json();
    mockEvidenceFindFirst.mockResolvedValue(evidence({ uploadState: 'stored' }));
    const second = await POST(req(), params());
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(first);
  });

  it('refuses with 424 (not 5xx) when the bucket cannot be checked yet', async () => {
    mockConfirm.mockResolvedValue({ uploadState: 'pending', bytes: 120, changed: false, reason: 'the storage backend cannot be reached' });
    const res = await POST(req(), params());
    expect(res.status).toBe(424);
    expect((await res.json()).uploadState).toBe('pending');
  });

  it('refuses with 424 (not 5xx) when a lookup throws', async () => {
    mockEvidenceFindFirst.mockRejectedValue(new Error('db down'));
    expect((await POST(req(), params())).status).toBe(424);
    mockEvidenceFindFirst.mockResolvedValue(evidence());
    mockConfirm.mockRejectedValue(new Error('boom'));
    expect((await POST(req(), params())).status).toBe(424);
  });
});

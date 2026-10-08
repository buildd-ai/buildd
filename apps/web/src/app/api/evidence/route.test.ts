import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false as any));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@/lib/evidence-backend', () => ({ getEvidenceS3Client: async () => { throw new Error('no bucket reads here'); } }));
mock.module('@/lib/storage', () => ({ getDefaultStorageClient: () => { throw new Error('no bucket reads here'); } }));

const mockWorkersFindMany = mock((_args: any) => Promise.resolve([] as any[]));
const mockObjFindMany = mock((_args: any) => Promise.resolve([] as any[]));
const mockObjFindFirst = mock((_args: any) => Promise.resolve(null as any));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      evidenceObjects: { findMany: mockObjFindMany, findFirst: mockObjFindFirst },
    },
  },
}));

import { GET } from './route';

const WS = '11111111-1111-4111-8111-111111111111';
const WS_OTHER = '22222222-2222-4222-8222-222222222222';
const TASK = 'abcdef12-3456-4789-8abc-def012345678';
const RETRY = 'bbbbbbbb-3456-4789-8abc-def012345678';
const EV = 'eeeeeeee-1111-4222-8333-444444444444';
const dialect = new PgDialect();

const req = (q: string) => new NextRequest(`http://localhost:3000/api/evidence?${q}`);

function obj(over: Record<string, unknown> = {}) {
  return {
    id: EV, workspaceId: WS, taskId: TASK, rootTaskId: TASK, workerId: 'w-1', prNumber: null,
    kind: 'ci_job_log', backendId: null, objectKey: 'evidence/k.log.gz', bytes: 10, sha256: null,
    uploadState: 'stored', indexState: 'skipped', expiresAt: null,
    createdAt: new Date('2026-09-30T00:00:00Z'), updatedAt: new Date('2026-09-30T00:00:00Z'),
    ...over,
  };
}

describe('GET /api/evidence', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1' });
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockImplementation(async (_a: string, ws: string) => ws === WS);
    mockWorkersFindMany.mockReset();
    mockWorkersFindMany.mockResolvedValue([{ taskId: TASK }, { taskId: TASK }, { taskId: null }]);
    mockObjFindMany.mockReset();
    mockObjFindMany.mockResolvedValue([obj(), obj({ id: 'r2', taskId: RETRY, rootTaskId: TASK })]);
    mockObjFindFirst.mockReset();
    mockObjFindFirst.mockResolvedValue(obj());
  });

  it('401s with no caller', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    expect((await GET(req(`workspaceId=${WS}&prNumber=7`))).status).toBe(401);
  });

  it('400s without a workspaceId, and without prNumber or evidenceId', async () => {
    expect((await GET(req('prNumber=7'))).status).toBe(400);
    expect((await GET(req(`workspaceId=${WS}`))).status).toBe(400);
    expect((await GET(req(`workspaceId=${WS}&prNumber=abc`))).status).toBe(400);
    expect((await GET(req(`workspaceId=${WS}&prNumber=7&kind=bogus`))).status).toBe(400);
  });

  it('404s a workspace the caller cannot access, before any query', async () => {
    const res = await GET(req(`workspaceId=${WS_OTHER}&prNumber=7`));
    expect(res.status).toBe(404);
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
    expect(mockObjFindMany).not.toHaveBeenCalled();
  });

  it('passes the request to auth, so a scoped token is checked against this route', async () => {
    await GET(req(`workspaceId=${WS}&prNumber=7`));
    const [, request] = mockAuthenticateApiKey.mock.calls[0] as any[];
    expect(request?.method).toBe('GET');
    expect(new URL(request.url).searchParams.get('workspaceId')).toBe(WS);
  });

  it('a caller with both a session and a bearer is decided by the account', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockImplementation(async () => ({ teamId: 't', role: 'member' }));
    // The session user reaches WS_OTHER; the bearer's account does not.
    expect((await GET(req(`workspaceId=${WS_OTHER}&prNumber=7`))).status).toBe(404);
    expect(mockObjFindMany).not.toHaveBeenCalled();
  });

  it('resolves a PR number to its tasks and their lineage, scoped to the workspace', async () => {
    const res = await GET(req(`workspaceId=${WS}&prNumber=7&kind=ci_job_log`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskIds).toEqual([TASK]);
    expect(body.objects.map((o: any) => o.id)).toEqual([EV, 'r2']);

    const w = dialect.sqlToQuery(mockWorkersFindMany.mock.calls[0][0].where);
    expect(w.params).toEqual(expect.arrayContaining([WS, 7]));
    expect(w.sql).toContain('"pr_number" = ');

    const q = dialect.sqlToQuery(mockObjFindMany.mock.calls[0][0].where);
    expect(q.sql).toContain('"workspace_id" = ');
    expect(q.sql).toContain('"task_id" in');
    expect(q.sql).toContain('"root_task_id" in');
    expect(q.params).toEqual(expect.arrayContaining([WS, 7, TASK, 'ci_job_log']));
  });

  it('drops rows the db returned from another workspace or an unrelated task', async () => {
    mockObjFindMany.mockResolvedValue([
      obj(),
      obj({ id: 'foreign-ws', workspaceId: WS_OTHER }),
      obj({ id: 'unrelated', taskId: RETRY, rootTaskId: RETRY }),
    ]);
    const body = await (await GET(req(`workspaceId=${WS}&prNumber=7`))).json();
    expect(body.objects.map((o: any) => o.id)).toEqual([EV]);
  });

  it('finds CI-log objects recorded against the PR even when no worker maps to it', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    mockObjFindMany.mockResolvedValue([obj({ prNumber: 7 })]);
    const body = await (await GET(req(`workspaceId=${WS}&prNumber=7`))).json();
    expect(body.objects).toHaveLength(1);
    const q = dialect.sqlToQuery(mockObjFindMany.mock.calls[0][0].where);
    expect(q.sql).not.toContain(' in ');
  });

  it('looks up one object by evidenceId within the workspace', async () => {
    const body = await (await GET(req(`workspaceId=${WS}&evidenceId=${EV}`))).json();
    expect(body.taskIds).toEqual([TASK]);
    const q = dialect.sqlToQuery(mockObjFindFirst.mock.calls[0][0].where);
    expect(q.params).toEqual(expect.arrayContaining([EV, WS]));
  });

  it('404s an evidenceId from another workspace', async () => {
    mockObjFindFirst.mockResolvedValue(obj({ workspaceId: WS_OTHER }));
    expect((await GET(req(`workspaceId=${WS}&evidenceId=${EV}`))).status).toBe(404);
  });

  it('never returns a URL or a bucket', async () => {
    const body = await (await GET(req(`workspaceId=${WS}&prNumber=7`))).text();
    expect(body).not.toMatch(/https?:\/\/|X-Amz|objectKey/);
  });

  it('writes an audit record', async () => {
    const lines: string[] = [];
    const orig = console.info;
    console.info = (...a: any[]) => { lines.push(a.join(' ')); };
    try {
      await GET(req(`workspaceId=${WS}&prNumber=7`));
    } finally {
      console.info = orig;
    }
    const audit = lines.filter(l => l.startsWith('[evidence-read]')).map(l => JSON.parse(l.slice('[evidence-read] '.length)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ surface: 'GET /api/evidence', workspaceId: WS, prNumber: 7, actor: { accountId: 'acct-1' } });
    expect(audit[0].evidenceIds).toEqual([EV, 'r2']);
  });

  describe('per-task token', () => {
    const scoped = { id: 'acct-1', level: 'worker', taskScope: { taskId: TASK, workspaceId: WS, expiresAt: Date.now() + 60_000 } };

    beforeEach(() => {
      mockAuthenticateApiKey.mockResolvedValue(scoped);
      // The minting account reaches both workspaces; only the token is narrower.
      mockVerifyAccountWorkspaceAccess.mockImplementation(async () => true);
    });

    it('lists evidence in its own task’s workspace', async () => {
      const res = await GET(req(`workspaceId=${WS}&prNumber=7`));
      expect(res.status).toBe(200);
      expect((await res.json()).objects).toHaveLength(2);
    });

    it('404s another workspace its account can reach, before any query', async () => {
      const res = await GET(req(`workspaceId=${WS_OTHER}&evidenceId=${EV}`));
      expect(res.status).toBe(404);
      expect(mockObjFindFirst).not.toHaveBeenCalled();
      expect(mockObjFindMany).not.toHaveBeenCalled();
    });

    it('leaves an account key unchanged: any workspace it can reach', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1' });
      expect((await GET(req(`workspaceId=${WS_OTHER}&prNumber=7`))).status).toBe(200);
    });
  });
});

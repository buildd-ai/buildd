import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import { gzipSync } from 'zlib';

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

const mockTaskFindFirst = mock(() => Promise.resolve(null as any));
const mockObjFindMany = mock((_args: any) => Promise.resolve([] as any[]));
const mockObjFindFirst = mock((_args: any) => Promise.resolve(null as any));
const mockBackendFindFirst = mock((_args: any) => Promise.resolve(null as any));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTaskFindFirst },
      evidenceObjects: { findMany: mockObjFindMany, findFirst: mockObjFindFirst },
      evidenceBackends: { findFirst: mockBackendFindFirst },
    },
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
  },
}));

let objectBody: Buffer = Buffer.from('');
const sent: any[] = [];
const fakeClient = {
  send: mock(async (cmd: any) => {
    sent.push(cmd.input);
    const buf = objectBody;
    return {
      Body: (async function* () {
        for (let i = 0; i < buf.length; i += 65536) yield buf.subarray(i, i + 65536);
      })(),
    };
  }),
};
const mockGetEvidenceS3Client = mock(async (_row: any) => fakeClient);
mock.module('@/lib/evidence-backend', () => ({ getEvidenceS3Client: mockGetEvidenceS3Client }));
mock.module('@/lib/storage', () => ({ getDefaultStorageClient: () => fakeClient }));

import { GET } from './route';

const TASK = 'abcdef12-3456-4789-8abc-def012345678';
const OTHER_TASK = 'bbbbbbbb-3456-4789-8abc-def012345678';
const EV = 'eeeeeeee-1111-4222-8333-444444444444';
const BACKEND = 'dddddddd-1111-4222-8333-444444444444';
const dialect = new PgDialect();

function req(id: string, q = '') {
  return new NextRequest(`http://localhost:3000/api/tasks/${id}/evidence${q ? `?${q}` : ''}`);
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function obj(over: Record<string, unknown> = {}) {
  return {
    id: EV, workspaceId: 'ws-mine', taskId: TASK, rootTaskId: TASK, workerId: 'w-1', prNumber: null,
    kind: 'command_output', backendId: BACKEND, objectKey: 'evidence/k.log.gz', bytes: 10, sha256: null,
    uploadState: 'stored', indexState: 'skipped', expiresAt: null,
    createdAt: new Date('2026-09-30T00:00:00Z'), updatedAt: new Date('2026-09-30T00:00:00Z'),
    ...over,
  };
}

const text = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');

describe('GET /api/tasks/[id]/evidence', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockImplementation(async (_u: string, ws: string) =>
      ws === 'ws-mine' ? { teamId: 't', role: 'member' } : null);
    mockTaskFindFirst.mockReset();
    mockTaskFindFirst.mockResolvedValue({ id: TASK, workspaceId: 'ws-mine' });
    mockObjFindMany.mockReset();
    mockObjFindMany.mockResolvedValue([]);
    mockObjFindFirst.mockReset();
    mockObjFindFirst.mockResolvedValue(obj());
    mockBackendFindFirst.mockReset();
    mockBackendFindFirst.mockResolvedValue({ id: BACKEND, provider: 's3', bucket: 'team-bucket' });
    mockGetEvidenceS3Client.mockClear();
    fakeClient.send.mockClear();
    sent.length = 0;
    objectBody = gzipSync(text(100, i => (i % 10 === 0 ? `FAIL case ${i}` : `ok ${i}`)));
  });

  it('401s with no caller', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(req(TASK), params(TASK));
    expect(res.status).toBe(401);
  });

  it('404s a task in a workspace the caller cannot access', async () => {
    mockTaskFindFirst.mockResolvedValue({ id: TASK, workspaceId: 'ws-other' });
    const res = await GET(req(TASK, `evidenceId=${EV}`), params(TASK));
    expect(res.status).toBe(404);
    expect(mockObjFindFirst).not.toHaveBeenCalled();
    expect(fakeClient.send).not.toHaveBeenCalled();
  });

  it('lists the lineage, scoped to the task and its root chain inside its workspace', async () => {
    mockObjFindMany.mockResolvedValue([obj(), obj({ id: 'x2', taskId: OTHER_TASK, rootTaskId: TASK })]);
    const res = await GET(req(TASK), params(TASK));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.objects.map((o: any) => o.id)).toEqual([EV, 'x2']);
    expect(body.objects[0].workspaceId).toBe('ws-mine');
    expect(JSON.stringify(body)).not.toContain('team-bucket');
    const q = dialect.sqlToQuery(mockObjFindMany.mock.calls[0][0].where);
    expect(q.sql).toContain('"task_id" = ');
    expect(q.sql).toContain('"root_task_id" = ');
    expect(q.sql).toContain('"workspace_id" = ');
    expect(q.params).toContain(TASK);
    expect(q.params).toContain('ws-mine');
  });

  it('drops a listed row that does not belong to the task, even if the db returned it', async () => {
    mockObjFindMany.mockResolvedValue([obj({ id: 'foreign', taskId: OTHER_TASK, rootTaskId: OTHER_TASK })]);
    const body = await (await GET(req(TASK), params(TASK))).json();
    expect(body.objects).toEqual([]);
  });

  it('scopes the object lookup by id, workspace and task lineage', async () => {
    const res = await GET(req(TASK, `evidenceId=${EV}&tail=5`), params(TASK));
    expect(res.status).toBe(200);
    const q = dialect.sqlToQuery(mockObjFindFirst.mock.calls[0][0].where);
    expect(q.params).toContain(EV);
    expect(q.params).toContain(TASK);
    expect(q.params).toContain('ws-mine');
    expect(q.sql).toContain('"task_id" = ');
    expect(q.sql).toContain('"root_task_id" = ');
  });

  it('404s an object whose task is not [id], without touching the bucket', async () => {
    mockObjFindFirst.mockResolvedValue(obj({ taskId: OTHER_TASK, rootTaskId: OTHER_TASK }));
    const res = await GET(req(TASK, `evidenceId=${EV}`), params(TASK));
    expect(res.status).toBe(404);
    expect(fakeClient.send).not.toHaveBeenCalled();
  });

  it('404s an object from another workspace', async () => {
    mockObjFindFirst.mockResolvedValue(obj({ workspaceId: 'ws-other' }));
    const res = await GET(req(TASK, `evidenceId=${EV}`), params(TASK));
    expect(res.status).toBe(404);
    expect(fakeClient.send).not.toHaveBeenCalled();
  });

  it('accepts an object that belongs to [id] through root_task_id', async () => {
    mockObjFindFirst.mockResolvedValue(obj({ taskId: OTHER_TASK, rootTaskId: TASK }));
    const res = await GET(req(TASK, `evidenceId=${EV}&tail=1`), params(TASK));
    expect(res.status).toBe(200);
  });

  it('tail returns only the last lines, read from the backend the object was written to', async () => {
    const res = await GET(req(TASK, `evidenceId=${EV}&tail=2`), params(TASK));
    const body = await res.json();
    expect(body.text).toBe('ok 99\nFAIL case 100');
    expect(body.truncated).toBe(false);
    expect(sent[0]).toEqual({ Bucket: 'team-bucket', Key: 'evidence/k.log.gz' });
    expect(mockBackendFindFirst).toHaveBeenCalled();
    expect(body.object.id).toBe(EV);
    expect(JSON.stringify(body)).not.toMatch(/X-Amz|https?:\/\//);
  });

  it('grep returns only matching lines', async () => {
    const res = await GET(req(TASK, `evidenceId=${EV}&grep=fail`), params(TASK));
    const body = await res.json();
    const out = body.text.split('\n');
    expect(out).toHaveLength(10);
    expect(out.every((l: string) => /FAIL case/.test(l))).toBe(true);
  });

  it('a 10 MB object returns at most 64 KB with truncated=true', async () => {
    objectBody = gzipSync(text(100_000, i => `${String(i).padStart(8, '0')} ${'x'.repeat(91)}`));
    const res = await GET(req(TASK, `evidenceId=${EV}&tail=10000`), params(TASK));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Buffer.byteLength(body.text)).toBeLessThanOrEqual(64 * 1024);
    expect(body.truncated).toBe(true);
  });

  it('400s an invalid regex', async () => {
    const res = await GET(req(TASK, `evidenceId=${EV}&grep=${encodeURIComponent('(oops')}`), params(TASK));
    expect(res.status).toBe(400);
    expect(fakeClient.send).not.toHaveBeenCalled();
  });

  it('400s a catastrophic-backtracking pattern and an over-long one', async () => {
    for (const p of ['(a+)+$', 'a'.repeat(201), '.*.*x', '\\s*\\s*x', 'a*a*b']) {
      const res = await GET(req(TASK, `evidenceId=${EV}&grep=${encodeURIComponent(p)}`), params(TASK));
      expect(res.status).toBe(400);
    }
  });

  it('400s a non-UUID evidenceId and an unknown kind', async () => {
    expect((await GET(req(TASK, 'evidenceId=nope'), params(TASK))).status).toBe(400);
    expect((await GET(req(TASK, 'kind=bogus'), params(TASK))).status).toBe(400);
  });

  it('an unreadable object is a clear 409, not a 500', async () => {
    mockObjFindFirst.mockResolvedValue(obj({ uploadState: 'unreadable' }));
    const res = await GET(req(TASK, `evidenceId=${EV}`), params(TASK));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('unreadable');
  });

  it('an object missing from its bucket is a 410', async () => {
    fakeClient.send.mockImplementationOnce(async () => { throw Object.assign(new Error('gone'), { name: 'NoSuchKey' }); });
    const res = await GET(req(TASK, `evidenceId=${EV}`), params(TASK));
    expect(res.status).toBe(410);
  });

  it('writes an audit record for a list and for a read', async () => {
    const lines: string[] = [];
    const orig = console.info;
    console.info = (...a: any[]) => { lines.push(a.join(' ')); };
    try {
      await GET(req(TASK), params(TASK));
      await GET(req(TASK, `evidenceId=${EV}&grep=fail`), params(TASK));
    } finally {
      console.info = orig;
    }
    const audit = lines.filter(l => l.startsWith('[evidence-read]')).map(l => JSON.parse(l.slice('[evidence-read] '.length)));
    expect(audit.map(a => a.op)).toEqual(['list', 'read']);
    expect(audit[1]).toMatchObject({ taskId: TASK, workspaceId: 'ws-mine', evidenceIds: [EV], actor: { userId: 'user-1' } });
    expect(audit[1].query.grep).toBe('fail');
  });
});

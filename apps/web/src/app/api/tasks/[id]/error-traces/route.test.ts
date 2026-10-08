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

const mockTaskFindFirst = mock(() => Promise.resolve(null as any));
const mockTracesFindMany = mock((_args: any) => Promise.resolve([] as any[]));
const mockPrefixRows = mock(() => Promise.resolve([] as any[]));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTaskFindFirst },
      workerErrorTraces: { findMany: mockTracesFindMany },
    },
    select: () => ({ from: () => ({ where: () => ({ limit: () => mockPrefixRows() }) }) }),
  },
}));

import { GET } from './route';

const FULL = 'abcdef12-3456-4789-8abc-def012345678';
const dialect = new PgDialect();

function req(id: string) {
  return new NextRequest(`http://localhost:3000/api/tasks/${id}/error-traces`);
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('GET /api/tasks/[id]/error-traces — id prefixes', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockImplementation(async (_u: string, ws: string) =>
      ws === 'ws-mine' ? { teamId: 't', role: 'member' } : null);
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockTaskFindFirst.mockReset();
    mockTaskFindFirst.mockResolvedValue({ id: FULL, workspaceId: 'ws-mine' });
    mockTracesFindMany.mockReset();
    mockTracesFindMany.mockResolvedValue([{ pattern: 'git_fatal', excerpt: 'fatal', source: 'bash', ts: 'x' }]);
    mockPrefixRows.mockReset();
    mockPrefixRows.mockResolvedValue([]);
  });

  it('resolves a unique 8-char prefix and queries traces by the full id', async () => {
    mockPrefixRows.mockResolvedValue([{ id: FULL, title: 'T', workspaceId: 'ws-mine' }]);
    const res = await GET(req('abcdef12'), params('abcdef12'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskId).toBe(FULL);
    expect(body.resolvedFrom).toBe('abcdef12');
    expect(body.count).toBe(1);
    const where = mockTracesFindMany.mock.calls[0][0].where;
    expect(dialect.sqlToQuery(where).params).toContain(FULL);
  });

  it('404s for a prefix that only matches another tenant\'s task', async () => {
    mockPrefixRows.mockResolvedValue([{ id: FULL, title: 'Secret', workspaceId: 'ws-other' }]);
    const res = await GET(req('abcdef12'), params('abcdef12'));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('Secret');
    expect(mockTracesFindMany).not.toHaveBeenCalled();
  });

  it('409s with candidates when the prefix is ambiguous', async () => {
    const other = 'abcdef12-0000-4000-8000-000000000000';
    mockPrefixRows.mockResolvedValue([
      { id: FULL, title: 'A', workspaceId: 'ws-mine' },
      { id: other, title: 'B', workspaceId: 'ws-mine' },
    ]);
    const res = await GET(req('abcdef12'), params('abcdef12'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.candidates.map((c: any) => c.id)).toEqual([FULL, other]);
    expect(mockTracesFindMany).not.toHaveBeenCalled();
  });

  it('400s on a malformed id instead of reaching Postgres with it', async () => {
    const res = await GET(req('task-abc'), params('task-abc'));
    expect(res.status).toBe(400);
    expect(mockTaskFindFirst).not.toHaveBeenCalled();
  });

  it('keeps the full-UUID path unchanged', async () => {
    const res = await GET(req(FULL), params(FULL));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolvedFrom).toBeUndefined();
    expect(body.count).toBe(1);
  });

  it('404s a full UUID in an inaccessible workspace', async () => {
    mockTaskFindFirst.mockResolvedValue({ id: FULL, workspaceId: 'ws-other' });
    const res = await GET(req(FULL), params(FULL));
    expect(res.status).toBe(404);
  });

  it('401s with no caller', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(req(FULL), params(FULL));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/tasks/[id]/error-traces — evidence', () => {
  const evidence = { errorClass: 'type_error', keyLines: ['a.ts(1,1): error TS2322'], diff: { files: 1, added: 2, removed: 0 }, links: {} };
  const mismatch = [{ kind: 'last_command_failed', detail: 'tsc exited 2' }];

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockImplementation(async (_u: string, ws: string) =>
      ws === 'ws-mine' ? { teamId: 't', role: 'member' } : null);
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    mockTaskFindFirst.mockReset();
    mockTracesFindMany.mockReset();
    mockTracesFindMany.mockResolvedValue([]);
    mockPrefixRows.mockReset();
    mockPrefixRows.mockResolvedValue([]);
  });

  it('returns the task\'s evidence and mismatch alongside the traces', async () => {
    mockTaskFindFirst.mockResolvedValue({ id: FULL, workspaceId: 'ws-mine', status: 'failed', result: { evidence, mismatch } });
    const body = await (await GET(req(FULL), params(FULL))).json();
    expect(body.status).toBe('failed');
    expect(body.evidence).toEqual(evidence);
    expect(body.mismatch).toEqual(mismatch);
  });

  it('returns null evidence and no mismatch for a task that recorded none', async () => {
    mockTaskFindFirst.mockResolvedValue({ id: FULL, workspaceId: 'ws-mine', status: 'completed', result: { summary: 'ok' } });
    const body = await (await GET(req(FULL), params(FULL))).json();
    expect(body.evidence).toBeNull();
    expect(body.mismatch).toEqual([]);
  });

  it('refuses evidence for a task outside the caller\'s teams', async () => {
    mockTaskFindFirst.mockResolvedValue({ id: FULL, workspaceId: 'ws-other', status: 'failed', result: { evidence, mismatch } });
    const res = await GET(req(FULL), params(FULL));
    expect(res.status).toBe(404);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('TS2322');
    expect(mockTracesFindMany).not.toHaveBeenCalled();
  });

  it('refuses an API key whose account cannot reach the task\'s workspace', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 't' });
    mockTaskFindFirst.mockResolvedValue({ id: FULL, workspaceId: 'ws-other', status: 'failed', result: { evidence } });
    const res = await GET(req(FULL), params(FULL));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('TS2322');
  });
});

describe('GET /api/tasks/[id]/error-traces — per-task token', () => {
  const scoped = { id: 'acct-1', teamId: 't', level: 'worker', taskScope: { taskId: 'task-own', workspaceId: 'ws-mine', expiresAt: Date.now() + 60_000 } };

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(scoped);
    mockVerifyAccountWorkspaceAccess.mockReset();
    // The minting account reaches both workspaces; only the token is narrower.
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockTaskFindFirst.mockReset();
    mockTracesFindMany.mockReset();
    mockTracesFindMany.mockResolvedValue([]);
    mockPrefixRows.mockReset();
    mockPrefixRows.mockResolvedValue([]);
  });

  it('reads traces of another task in its own workspace', async () => {
    mockTaskFindFirst.mockResolvedValue({ id: FULL, workspaceId: 'ws-mine', status: 'failed', result: null });
    const res = await GET(req(FULL), params(FULL));
    expect(res.status).toBe(200);
  });

  it('404s on a task in another workspace its account can reach', async () => {
    mockTaskFindFirst.mockResolvedValue({ id: FULL, workspaceId: 'ws-other', status: 'failed', result: null });
    const res = await GET(req(FULL), params(FULL));
    expect(res.status).toBe(404);
    expect(mockTracesFindMany).not.toHaveBeenCalled();
  });

  it('does not resolve a prefix to a task in another workspace', async () => {
    mockPrefixRows.mockResolvedValue([{ id: FULL, title: 'Elsewhere', workspaceId: 'ws-other' }]);
    const res = await GET(req('abcdef12'), params('abcdef12'));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('Elsewhere');
  });

  it('leaves an account key unchanged: any workspace it can reach', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 't' });
    mockTaskFindFirst.mockResolvedValue({ id: FULL, workspaceId: 'ws-other', status: 'failed', result: null });
    const res = await GET(req(FULL), params(FULL));
    expect(res.status).toBe(200);
  });
});


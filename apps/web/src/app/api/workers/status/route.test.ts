import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

// GET /api/workers/status?ids=… — the runner's reconcile reads every live
// worker's status in one request instead of one full-row GET per worker.

const mockAuth = mock(async (_key: string | null, _req: unknown) => null as any);
mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: mockAuth,
  // The real owner check reads these; keep them permissive for a plain key.
  taskScopeAllowsWorker: (account: any, worker: any) => !account.taskScope || account.taskScope.taskId === worker.taskId,
}));

const wheres: any[] = [];
let ownedRows: any[] = [];
let existingRows: any[] = [];
let selectCalls = 0;
const selectChain = (projection: Record<string, unknown>) => {
  selectCalls++;
  const isOwnedRead = 'taskStatus' in projection;
  const chain: any = {
    from: () => chain,
    leftJoin: () => chain,
    where: (w: any) => { wheres.push(w); return chain; },
    then: (resolve: any, reject: any) => Promise.resolve(isOwnedRead ? ownedRows : existingRows).then(resolve, reject),
  };
  return chain;
};
mock.module('@buildd/core/db', () => ({ db: { select: (p: Record<string, unknown>) => selectChain(p) } }));

const { GET } = await import('./route');

const dialect = new PgDialect();
const sqlOf = (w: any) => dialect.sqlToQuery(w);

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function req(qs: string, auth = true) {
  return new NextRequest(`http://localhost:3000/api/workers/status${qs}`, {
    headers: auth ? { Authorization: 'Bearer bld_test' } : {},
  });
}

describe('GET /api/workers/status', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    wheres.length = 0;
    ownedRows = [];
    existingRows = [];
    selectCalls = 0;
  });

  it('401 without a caller', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(req(`?ids=${A}`, false));
    expect(res.status).toBe(401);
  });

  it('400 without ids, and past the cap', async () => {
    mockAuth.mockResolvedValue({ id: 'acct-1' });
    expect((await GET(req(''))).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`).join(',');
    expect((await GET(req(`?ids=${many}`))).status).toBe(400);
  });

  it('answers status, error and task status for owned workers, scoped to the account in SQL', async () => {
    mockAuth.mockResolvedValue({ id: 'acct-1' });
    ownedRows = [
      { id: A, status: 'running', error: null, accountId: 'acct-1', taskId: 't1', workspaceId: 'w1', claimedByUserId: null, taskStatus: 'in_progress' },
      { id: B, status: 'waiting_input', error: 'needs_input: which?', accountId: 'acct-1', taskId: 't2', workspaceId: 'w1', claimedByUserId: null, taskStatus: 'cancelled' },
    ];
    existingRows = [];
    const res = await GET(req(`?ids=${A},${B}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workers[A]).toEqual({ status: 'running', error: null, task: { status: 'in_progress' } });
    expect(body.workers[B]).toEqual({ status: 'waiting_input', error: 'needs_input: which?', task: { status: 'cancelled' } });
    expect(body.missing).toEqual([]);
    // One read when every id came back.
    expect(selectCalls).toBe(1);
    const q = sqlOf(wheres[0]);
    expect(q.sql).toContain('"workers"."account_id" = $');
    expect(q.params).toContain('acct-1');
    expect(q.params).toEqual(expect.arrayContaining([A, B]));
  });

  it('lists an id with no row at all as missing; a row on another account is neither owned nor missing', async () => {
    mockAuth.mockResolvedValue({ id: 'acct-1' });
    ownedRows = [{ id: A, status: 'running', error: null, accountId: 'acct-1', taskId: 't1', workspaceId: 'w1', claimedByUserId: null, taskStatus: 'in_progress' }];
    // B exists (another account's), C does not.
    existingRows = [{ id: B }];
    const body = await (await GET(req(`?ids=${A},${B},${C}`))).json();
    expect(Object.keys(body.workers)).toEqual([A]);
    expect(body.missing).toEqual([C]);
    // The existence read names only the ids the owned read did not return.
    const q = sqlOf(wheres[1]);
    expect(q.params).toEqual(expect.arrayContaining([B, C]));
    expect(q.params).not.toContain(A);
  });

  it('a non-UUID id can never name a worker: missing, and never sent to SQL', async () => {
    mockAuth.mockResolvedValue({ id: 'acct-1' });
    const body = await (await GET(req(`?ids=not-a-uuid`))).json();
    expect(body.missing).toEqual(['not-a-uuid']);
    expect(selectCalls).toBe(0);
  });

  it('a per-task token is confined to its own task in SQL', async () => {
    mockAuth.mockResolvedValue({ id: 'acct-1', level: 'worker', taskScope: { taskId: 't1', expiresAt: Date.now() + 60_000 } });
    ownedRows = [];
    existingRows = [{ id: A }];
    await GET(req(`?ids=${A}`));
    const q = sqlOf(wheres[0]);
    expect(q.sql).toContain('"workers"."task_id" = $');
    expect(q.params).toContain('t1');
  });

  it('a session-claimed worker is not owned by a key on the same account', async () => {
    mockAuth.mockResolvedValue({ id: 'acct-1' });
    ownedRows = [{ id: A, status: 'running', error: null, accountId: 'acct-1', taskId: 't1', workspaceId: 'w1', claimedByUserId: 'user-9', taskStatus: 'in_progress' }];
    existingRows = [{ id: A }];
    const body = await (await GET(req(`?ids=${A}`))).json();
    expect(body.workers[A]).toBeUndefined();
    expect(body.missing).toEqual([]);
  });
});

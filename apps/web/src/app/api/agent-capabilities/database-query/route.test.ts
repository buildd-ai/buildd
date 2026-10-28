import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mocks (before importing the route) ────────────────────────────────────────

const mockAuth = mock((_key: string | null) => Promise.resolve(null as any));
const mockResolvePrincipal = mock((_a: any, _i: any) => Promise.resolve(null as any));
const mockAudit = mock((_row: any) => Promise.resolve());
const mockFindGrant = mock((_p: any) => Promise.resolve({ ok: false, reasonCode: 'no_grant' } as any));
const mockExecute = mock((_sql: string, _params: unknown[]) => Promise.resolve({ rows: [{ id: 't1' }], fields: ['id'] } as any));

mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: mockAuth,
  taskScopeAllowsWorker: (a: any, w: any) => !a.taskScope || w.taskId === a.taskScope.taskId,
  taskScopeAllowsWorkspace: (a: any, ws: any) => !a.taskScope || ws === a.taskScope.workspaceId,
}));
mock.module('@/lib/agent-capabilities/worker-principal', () => ({ resolveWorkerPrincipal: mockResolvePrincipal }));
mock.module('@/lib/agent-capabilities/audit', () => ({ recordCapabilityDecision: mockAudit }));
// The broker's rules are real; only the grant lookup and the connection are fakes.
mock.module('@/lib/capability-database-query-store', () => ({
  defaultDatabaseQueryDeps: (audit: any) => ({
    findGrant: mockFindGrant,
    execute: mockExecute,
    knownTables: ['tasks', 'missions', 'secrets', 'accounts'],
    audit,
  }),
}));

import { POST } from './route';

// ── fixtures (illustrative) ───────────────────────────────────────────────────

const TASK = '22222222-2222-4222-8222-222222222222';
const WS = '33333333-3333-4333-8333-333333333333';
const WORKER = '11111111-1111-4111-8111-111111111111';
const GRANT = '66666666-6666-4666-8666-666666666666';
const ACCOUNT = { id: '55555555-5555-4555-8555-555555555555', teamId: 'team-1', level: 'worker' };
const TASK_TOKEN_ACCOUNT = { ...ACCOUNT, taskScope: { taskId: TASK, workspaceId: WS, expiresAt: Date.now() + 60_000 } };
const PRINCIPAL = { kind: 'agent_run', via: 'task_token', workerId: WORKER, taskId: TASK, workspaceId: WS, teamId: 'team-1', accountId: ACCOUNT.id };

function req(body: unknown, apiKey: string | null = 'bldt_token') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return new NextRequest('http://localhost/api/agent-capabilities/database-query', { method: 'POST', headers, body: JSON.stringify(body) });
}
const audits = () => mockAudit.mock.calls.map(c => c[0] as any);

beforeEach(() => {
  mockAuth.mockReset();
  mockResolvePrincipal.mockReset();
  mockAudit.mockClear();
  mockFindGrant.mockReset();
  mockExecute.mockClear();
  mockAuth.mockImplementation((key: string | null) => Promise.resolve(key ? TASK_TOKEN_ACCOUNT : null));
  mockResolvePrincipal.mockResolvedValue({ ok: true, principal: PRINCIPAL, workspace: { id: WS } });
  mockFindGrant.mockResolvedValue({ ok: true, grantId: GRANT, expiresAt: new Date(Date.now() + 3_600_000) });
});

describe('POST /api/agent-capabilities/database-query', () => {
  it('401s without a credential and refuses a trigger token', async () => {
    expect((await POST(req({ workerId: WORKER, sql: 'select 1' }, null))).status).toBe(401);
    mockAuth.mockResolvedValue({ ...ACCOUNT, level: 'trigger' });
    expect((await POST(req({ workerId: WORKER, sql: 'select 1' }))).status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("a task token cannot query under another task's worker", async () => {
    mockResolvePrincipal.mockResolvedValue({ ok: true, principal: { ...PRINCIPAL, taskId: 'other-task' }, workspace: { id: WS } });
    expect((await POST(req({ workerId: WORKER, sql: 'select id from tasks' }))).status).toBe(404);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('with no grant: 403 no_grant and the request_capability step; recorded', async () => {
    mockFindGrant.mockResolvedValue({ ok: false, reasonCode: 'no_grant' });
    const res = await POST(req({ workerId: WORKER, sql: 'select id from tasks' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'no_grant', requestWith: { tool: 'request_capability', params: { provider: 'neon', access: 'read' } } });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(audits()).toEqual([expect.objectContaining({ capability: 'database.query', decision: 'refused', taskId: TASK, reasonCode: 'no_grant', sideEffect: expect.objectContaining({ sql: 'select id from tasks' }) })]);
  });

  it('a read grant cannot run INSERT, UPDATE or DDL', async () => {
    for (const sql of ['insert into tasks (id) values (1)', 'update tasks set status = 1', 'alter table tasks drop column id']) {
      const res = await POST(req({ workerId: WORKER, sql }));
      expect(res.status).toBe(400);
    }
    expect(mockExecute).not.toHaveBeenCalled();
    expect(audits().map(a => a.decision)).toEqual(['refused', 'refused', 'refused']);
  });

  it('a table outside the allowlist is refused', async () => {
    const res = await POST(req({ workerId: WORKER, sql: 'select * from secrets' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('table_not_allowed');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('a granted SELECT returns rows; the trail gets SQL, row count and duration, never rows', async () => {
    const res = await POST(req({ workerId: WORKER, sql: 'select id from tasks where status = $1', params: ['failed'], maxRows: 10 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rows: [{ id: 't1' }], fields: ['id'], rowCount: 1, truncated: false, grantId: GRANT });
    expect(mockExecute.mock.calls[0][0]).toContain('LIMIT 11');
    expect(mockExecute.mock.calls[0][1]).toEqual(['failed']);
    const [row] = audits();
    expect(row).toMatchObject({ capability: 'database.query', decision: 'allowed', resource: `grant:${GRANT}`, taskId: TASK, workerId: WORKER });
    expect(row.sideEffect).toMatchObject({ sql: 'select id from tasks where status = $1', rowCount: 1 });
    expect(typeof row.sideEffect.durationMs).toBe('number');
    expect(JSON.stringify(row)).not.toContain('t1');
  });

  it('refuses plumbing in the body', async () => {
    const res = await POST(req({ workerId: WORKER, sql: 'select 1 from tasks', connectionString: 'postgres://owner@db' }));
    expect(res.status).toBe(400);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

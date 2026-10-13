import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

type Account = { id: string; taskScope?: { taskId: string; workspaceId: string } };
let account: Account | null = null;
let user: { id: string } | null = null;
const calls: unknown[] = [];
mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: async () => account,
  taskScopeAllowsWorkspace: (a: Account, ws: string | null) => !a.taskScope || (!!ws && ws === a.taskScope.workspaceId),
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/specs/outcome', () => ({
  governedTaskWorkspace: async () => 'ws-a',
  readGovernedOutcome: async (c: unknown) => { calls.push(['read', c]); return { ok: true, outcome: { outcome: 'unverified' } }; },
  recordSpecVerdict: async (c: unknown, _t: string, input: unknown) => { calls.push(['record', c, input]); return { ok: true, verdictId: 'v1', outcome: { outcome: 'fail' } }; },
}));
mock.module('@/modules', () => ({
  VISUAL_SPEC_VERDICT: async (c: unknown, _t: string, input: unknown) => { calls.push(['visual', c, input]); return { ok: true, verdictId: 'v2', outcome: { outcome: 'unverified' } }; },
}));
const { GET, POST } = await import('./route');
const params = Promise.resolve({ taskId: 't1' });
const get = () => GET(new NextRequest('http://l/api/specs/outcomes/t1'), { params });
const post = (body: unknown) => POST(new NextRequest('http://l/api/specs/outcomes/t1', { method: 'POST', body: JSON.stringify(body) }), { params });

describe('/api/specs/outcomes/[taskId]', () => {
  it('a task token for another workspace is a 404 and reaches nothing', async () => {
    account = { id: 'a1', taskScope: { taskId: 'x', workspaceId: 'ws-b' } };
    calls.length = 0;
    expect((await get()).status).toBe(404);
    expect((await post({ criterionId: 'R-1', verdict: 'pass', headSha: 'a'.repeat(40) })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('a token in the task workspace goes to the lib with its scope, and the body fields pass through', async () => {
    account = { id: 'a1', taskScope: { taskId: 'r1', workspaceId: 'ws-a' } };
    const res = await post({ criterionId: 'R-1', verdict: 'fail', headSha: 'a'.repeat(40), readIds: ['x'], extra: 'dropped' });
    expect([res.status, (await res.json()).outcome.outcome]).toEqual([200, 'fail']);
    expect(calls.at(-1)).toEqual(['record', { kind: 'account', account }, { criterionId: 'R-1', verdict: 'fail', headSha: 'a'.repeat(40), evidenceRefs: undefined, readIds: ['x'], observed: undefined }]);
  });

  it('checker visual goes to the visual verdict path with its own fields, never the reviewer path', async () => {
    account = { id: 'a1', taskScope: { taskId: 'audit-1', workspaceId: 'ws-a' } };
    const res = await post({ checker: 'visual', criterionId: 'AC-1', verdict: 'pass', capturedSha: 'c'.repeat(40), screenshotIds: ['s1'], headSha: 'a'.repeat(40), evidenceRefs: [{ kind: 'x', ref: 'y' }] });
    expect([res.status, (await res.json()).verdictId]).toEqual([200, 'v2']);
    expect(calls.at(-1)).toEqual(['visual', { kind: 'account', account }, { criterionId: 'AC-1', verdict: 'pass', capturedSha: 'c'.repeat(40), screenshotIds: ['s1'], designShotIds: undefined, observed: undefined }]);
  });

  it('a person session reads; no caller is a 401', async () => {
    account = null; user = { id: 'u1' };
    expect((await get()).status).toBe(200);
    expect(calls.at(-1)).toEqual(['read', { kind: 'user', userId: 'u1' }]);
    user = null;
    expect((await get()).status).toBe(401);
  });
});

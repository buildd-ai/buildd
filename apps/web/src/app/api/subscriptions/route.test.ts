import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TASK = '11111111-1111-4111-8111-111111111111';
const DONE_TASK = '22222222-2222-4222-8222-222222222222';
const WS = '55555555-5555-4555-8555-555555555555';
const NO_REPO_WS = '88888888-8888-4888-8888-888888888888';
const CONV = '66666666-6666-4666-8666-666666666666';
// Another team's: a finished task and a merged PR the caller cannot see.
const HIDDEN_DONE = '33333333-3333-4333-8333-333333333333';
const HIDDEN_WS = '77777777-7777-4777-8777-777777777777';
const lookups: any[] = [];

let signedIn = true;
let active: any[] = [];
const created: any[] = [];
let createReturnsNull = false;

mock.module('@/lib/auth-helpers', () => ({
  requireSessionUser: async () => (signedIn
    ? { user: { id: 'u-1' } }
    : { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }),
}));
mock.module('@/lib/subscriptions', () => ({
  createSubscription: async (input: any) => {
    created.push(input);
    return createReturnsNull ? null : { id: 'sub-1', teamId: 't-1', workspaceId: WS, subjectKind: input.subject.kind, eventTypes: input.eventTypes };
  },
  listSubscriptions: async () => active,
}));
mock.module('@/lib/watch-subjects', () => ({
  TERMINAL_TASK_STATUSES: ['completed', 'failed', 'cancelled'],
  // Scoped to the caller: what they can't see reads as nothing, whatever its state.
  taskSubject: async (id: string, userId: string) => (lookups.push(['task', id, userId]), userId !== 'u-1' || id === HIDDEN_DONE ? null : id === TASK ? { id, title: 'Checkout rounding', status: 'in_progress', workspaceId: WS }
    : id === DONE_TASK ? { id, title: 'Old', status: 'completed', workspaceId: WS } : null),
  prSubject: async (ws: string, n: number, userId: string) => (lookups.push(['pr', ws, n, userId]), userId !== 'u-1' || ws === HIDDEN_WS ? { ok: false, reason: 'not_found' } : ws === NO_REPO_WS ? { ok: false, reason: 'no_repo' }
    : ws !== WS ? { ok: false, reason: 'not_found' }
      : { ok: true, repoFullName: 'acme/widgets', merged: n === 9, title: null }),
  watchLabels: async (subs: any[]) => new Map(subs.map(s => [s.id, `label ${s.id}`])),
}));

const { GET, POST } = await import('./route');
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/subscriptions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => { lookups.length = 0; signedIn = true; active = []; created.length = 0; createReturnsNull = false; });

describe('POST /api/subscriptions: a one-shot watch for the signed-in person', () => {
  it('a task: owner is the person, defaults to finished-or-failed, origin conversation kept', async () => {
    const res = await post({ taskId: TASK, conversationId: CONV });
    expect(res.status).toBe(201);
    expect(created).toEqual([{
      owner: { userId: 'u-1' }, subject: { kind: 'task', taskId: TASK }, eventTypes: ['task.completed', 'task.failed'],
      lifetime: 'one_shot', conversationId: CONV, createdVia: 'chat',
    }]);
  });

  it('a PR by number in a workspace: repo from the workspace link, defaults to merged', async () => {
    const res = await post({ workspaceId: WS, prNumber: 42, eventTypes: ['pr.merged', 'pr.ci_failed'] });
    expect(res.status).toBe(201);
    expect(created[0]).toMatchObject({
      subject: { kind: 'pr', workspaceId: WS, repoFullName: 'acme/widgets', prNumber: 42 },
      eventTypes: ['pr.merged', 'pr.ci_failed'], createdVia: 'settings', conversationId: null,
    });
  });

  it('refuses a standing watch in P1', async () => {
    const res = await post({ taskId: TASK, lifetime: 'standing' });
    expect(res.status).toBe(400);
    expect(created).toEqual([]);
  });

  it('a task that already ended, or a PR that already merged, can never fire: 409, nothing written', async () => {
    expect((await post({ taskId: DONE_TASK })).status).toBe(409);
    expect((await post({ workspaceId: WS, prNumber: 9 })).status).toBe(409);
    expect(created).toEqual([]);
  });

  it('a subject the person cannot see is not found', async () => {
    expect((await post({ taskId: '99999999-9999-4999-8999-999999999999' })).status).toBe(404);
    createReturnsNull = true;
    expect((await post({ taskId: TASK })).status).toBe(404);
  });

  it('a task or PR the caller cannot see is a plain 404: no status, no existence, no merge state', async () => {
    const t = await post({ taskId: HIDDEN_DONE });
    expect(t.status).toBe(404);
    expect(JSON.stringify(await t.json())).not.toMatch(/completed|already|ended/);
    const p = await post({ workspaceId: HIDDEN_WS, prNumber: 9 });
    expect(p.status).toBe(404);
    expect(JSON.stringify(await p.json())).not.toMatch(/merged|repo|already/);
    // Every lookup is asked as the caller.
    expect(lookups).toEqual([['task', HIDDEN_DONE, 'u-1'], ['pr', HIDDEN_WS, 9, 'u-1']]);
    expect(created).toEqual([]);
  });

  it('a workspace with no GitHub repo linked cannot watch a PR', async () => {
    const res = await post({ workspaceId: NO_REPO_WS, prNumber: 4 });
    expect(res.status).toBe(400);
  });

  it('event types that do not fit the subject are refused', async () => {
    expect((await post({ taskId: TASK, eventTypes: ['pr.merged'] })).status).toBe(400);
  });

  it('needs exactly one subject', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ taskId: TASK, workspaceId: WS, prNumber: 3 })).status).toBe(400);
    expect((await post({ taskId: 'not-a-uuid' })).status).toBe(400);
  });

  it('caps live watches per person', async () => {
    active = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}` }));
    expect((await post({ taskId: TASK })).status).toBe(429);
    expect(created).toEqual([]);
  });

  it('needs a signed-in person', async () => {
    signedIn = false;
    expect((await post({ taskId: TASK })).status).toBe(401);
  });
});

describe('GET /api/subscriptions', () => {
  it('lists the person\'s live watches with a label each', async () => {
    active = [{ id: 's1', teamId: 't-1', workspaceId: WS }];
    const res = await GET(new NextRequest('http://localhost/api/subscriptions'));
    expect(await res.json()).toEqual({ subscriptions: [{ id: 's1', teamId: 't-1', workspaceId: WS, label: 'label s1' }] });
  });
});

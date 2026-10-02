/**
 * POST /api/workers/[id]/question-check: the question gate's route. The gate
 * itself is covered in lib/question-gate-check.test.ts; this pins auth,
 * ownership, body validation and the scope the check runs under.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

let authed: { id: string } | null;
let authArgs: unknown[];
let worker: { id: string; accountId: string; workspaceId: string; taskId: string | null } | null;
let workspace: { id: string; teamId: string | null; dataClass: string | null } | null;
let task: { title: string } | null;
let checked: Array<{ scope: unknown; req: unknown }>;

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async (...args: unknown[]) => { authArgs = args; return authed; } }));
mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'workers.id' }, workspaces: { id: 'workspaces.id' }, tasks: { id: 'tasks.id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
mock.module('@buildd/core/db', () => ({
  db: { query: {
    workers: { findFirst: async () => worker },
    workspaces: { findFirst: async () => workspace },
    tasks: { findFirst: async () => task },
  } },
}));
mock.module('@/lib/question-gate-check', () => ({
  checkQuestion: async (scope: unknown, req: unknown) => {
    checked.push({ scope, req });
    return { verdict: 'pushback', outcome: 'pushback', reason: 'Not sent: ...', version: 'v', latencyMs: 3 };
  },
}));

import { POST } from './route';

const BODY = { question: { prompt: 'Local or UTC?', options: ['Local', 'UTC'] }, priorPushbacks: 0 };

const req = (body: unknown, apiKey: string | null = 'bld_runner') =>
  new NextRequest(`http://localhost/api/workers/${WORKER}/question-check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const params = (id = WORKER) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  authed = { id: ACCOUNT };
  authArgs = [];
  worker = { id: WORKER, accountId: ACCOUNT, workspaceId: 'ws-1', taskId: 'task-1' };
  workspace = { id: 'ws-1', teamId: 'team-1', dataClass: null };
  task = { title: 'Weekend surcharge' };
  checked = [];
});

describe('POST /api/workers/[id]/question-check', () => {
  it('401 without a key; auth sees the request (scoped keys)', async () => {
    authed = null;
    expect((await POST(req(BODY, null), params())).status).toBe(401);
    expect(authArgs[1]).toBeInstanceOf(NextRequest);
  });

  it('404 for a non-UUID id or another account\'s worker', async () => {
    expect((await POST(req(BODY), params('nope'))).status).toBe(404);
    worker = { ...worker!, accountId: 'someone-else' };
    expect((await POST(req(BODY), params())).status).toBe(404);
    expect(checked).toEqual([]);
  });

  it('400 on malformed JSON or a missing prompt', async () => {
    expect((await POST(req('{nope'), params())).status).toBe(400);
    expect((await POST(req({ question: {} }), params())).status).toBe(400);
    expect(checked).toEqual([]);
  });

  it('a worker with no task is sent as-is', async () => {
    worker = { ...worker!, taskId: null };
    const res = await POST(req(BODY), params());
    expect(await res.json()).toMatchObject({ verdict: 'send', outcome: 'off' });
    expect(checked).toEqual([]);
  });

  it('checks under the worker\'s team, task and sensitivity', async () => {
    workspace = { ...workspace!, dataClass: 'sensitive' };
    const res = await POST(req(BODY), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verdict: 'pushback' });
    expect(checked).toHaveLength(1);
    expect(checked[0].scope).toEqual({
      teamId: 'team-1', workspaceId: 'ws-1', accountId: ACCOUNT, taskId: 'task-1', workerId: WORKER,
      taskTitle: 'Weekend surcharge', sensitive: true,
    });
    expect((checked[0].req as any).question.prompt).toBe('Local or UTC?');
  });
});

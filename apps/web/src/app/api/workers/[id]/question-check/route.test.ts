/**
 * POST /api/workers/[id]/question-check: the question gate's route. The gate
 * itself is covered in lib/question-gate-check.test.ts; this pins auth,
 * ownership, body validation and the scope the check runs under (including
 * the kill switch and hard-rail context read off the workspace/task rows).
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

let authed: { id: string; teamId?: string | null; sessionUserId?: string | null; level?: string } | null;
let authArgs: unknown[];
let worker: { id: string; accountId: string; workspaceId: string; taskId: string | null; claimedByUserId?: string | null } | null;
let workspace: { id: string; teamId: string | null; dataClass: string | null; gitConfig: unknown } | null;
let task: { title: string; pathManifest: string[] | null; missionId: string | null } | null;
let checked: Array<{ scope: unknown; req: unknown; deps?: any }>;
const repairSlot = async () => null;

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
mock.module('@/modules', () => ({ RECOVERABLE_BLOCKER_REPAIR: repairSlot }));
mock.module('@/lib/question-gate-check', () => ({
  checkQuestion: async (scope: unknown, req: unknown, deps?: any) => {
    checked.push({ scope, req, deps });
    return { verdict: 'pushback', outcome: 'pushback', reason: 'Not sent: ...', version: 'v', latencyMs: 3 };
  },
  gateEnabledFromGitConfig: (gc: any) => gc?.jevQuestionGate !== false,
  hardRailContextFromGitConfig: (gc: any) => ({
    schemaPaths: gc?.policyConfig?.riskClasses?.find((c: any) => c.name === 'destructive_schema_change')?.detectedPaths,
    authSecretsPaths: undefined,
    ciDeployPaths: undefined,
    ...(gc?.mergePolicy?.threshold?.denyPaths ? { protectedPaths: gc.mergePolicy.threshold.denyPaths } : {}),
  }),
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
  workspace = { id: 'ws-1', teamId: 'team-1', dataClass: null, gitConfig: null };
  task = { title: 'Weekend surcharge', pathManifest: null, missionId: null };
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

  it('checks under the worker\'s team, task, sensitivity and the kill switch, with the task\'s pathManifest as hard-rail context', async () => {
    workspace = { ...workspace!, dataClass: 'sensitive', gitConfig: { jevQuestionGate: false, mergePolicy: { threshold: { denyPaths: ['infra/'] } } } };
    task = { ...task!, pathManifest: ['infra/terraform/main.tf'], missionId: 'mission-1' };
    const res = await POST(req(BODY), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verdict: 'pushback' });
    expect(checked).toHaveLength(1);
    expect(checked[0].scope).toMatchObject({
      teamId: 'team-1', workspaceId: 'ws-1', accountId: ACCOUNT, taskId: 'task-1', missionId: 'mission-1', workerId: WORKER,
      taskTitle: 'Weekend surcharge', sensitive: true, gateEnabled: false,
      hardRail: { pathManifest: ['infra/terraform/main.tf'], protectedPaths: ['infra/'] },
    });
    expect((checked[0].req as any).question.prompt).toBe('Local or UTC?');
    // The recover slot comes from the composition root, so a recoverable blocker can be repaired.
    expect(checked[0].deps?.fileRepair).toBe(repairSlot);
  });

  it('defaults gateEnabled true and an empty hard-rail context with no gitConfig', async () => {
    await POST(req(BODY), params());
    expect(checked[0].scope).toMatchObject({ gateEnabled: true, hardRail: { pathManifest: null } });
  });
});

describe('POST /api/workers/[id]/question-check — OAuth session owner check', () => {
  // Invariant: an OAuth session acts as an account its whole team shares, so the
  // account id alone does not say who claimed the worker. Only the session user
  // recorded as claimedByUserId owns it; any other member, an admin included, or
  // a session with no team, gets the same 404 a stranger's worker does.
  const session = (sessionUserId: string, extra: Record<string, unknown> = {}) =>
    ({ id: ACCOUNT, teamId: 'team-1', sessionUserId, level: 'worker', ...extra });

  beforeEach(() => {
    worker = { id: WORKER, accountId: ACCOUNT, workspaceId: 'ws-1', taskId: 'task-1', claimedByUserId: 'user-a' };
  });

  it('the session user that claimed the worker is allowed', async () => {
    authed = session('user-a');
    const res = await POST(req(BODY, 'oauth-token'), params());
    expect(res.status).toBe(200);
    expect(checked).toHaveLength(1);
  });

  it('another member of the same team on the same account is refused, and nothing is checked', async () => {
    authed = session('user-b');
    expect((await POST(req(BODY, 'oauth-token'), params())).status).toBe(404);
    expect(checked).toEqual([]);
  });

  it('an admin-level session that did not claim the worker is refused too', async () => {
    authed = session('user-b', { level: 'admin' });
    expect((await POST(req(BODY, 'oauth-token'), params())).status).toBe(404);
    expect(checked).toEqual([]);
  });

  it('a session with no team id is refused even when the user matches', async () => {
    authed = session('user-a', { teamId: null });
    expect((await POST(req(BODY, 'oauth-token'), params())).status).toBe(404);
    expect(checked).toEqual([]);
  });
});

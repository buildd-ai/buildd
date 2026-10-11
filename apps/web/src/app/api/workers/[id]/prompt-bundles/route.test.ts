/**
 * GET /api/workers/[id]/prompt-bundles — a runner that lost a worker's
 * role/skill payload (runner restart, park → reattach) re-fetches it before
 * resuming the session. Same resolution as the claim response.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

type Row = { id: string; accountId: string; taskId: string | null; workspaceId?: string | null; claimedByUserId?: string | null; task: Record<string, unknown> | null };
let row: Row | null;
let authed: { id: string; level?: string; teamId?: string | null; sessionUserId?: string | null; taskScope?: { taskId: string; workspaceId: string; expiresAt: number } } | null;
const attachCalls: Array<{ fn: string; cw: any; tasks: any[]; accountId: string }> = [];

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => authed }));
mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'workers.id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
mock.module('@buildd/core/db', () => ({
  db: { query: { workers: { findFirst: async () => row } } },
}));
mock.module('../../claim/skill-and-role-injection', () => ({
  attachSkillBundles: async (cws: any[], tasks: any[], accountId: string) => {
    attachCalls.push({ fn: 'skills', cw: cws[0], tasks, accountId });
    if ((cws[0].task?.context?.skillSlugs ?? []).length) {
      cws[0].skillBundles = [{ slug: 'ship', name: 'Ship', content: 'body' }];
    }
  },
  attachRoleConfig: async (cws: any[], tasks: any[], accountId: string) => {
    attachCalls.push({ fn: 'role', cw: cws[0], tasks, accountId });
    if (tasks[0]?.roleSlug) {
      cws[0].roleInstructions = { slug: 'builder', name: 'Builder', content: 'persona' };
      cws[0].roleConfig = { slug: 'builder', configHash: 'h', configUrl: 'https://r2.example/presigned', type: 'builder', model: 'inherit', allowedTools: [], canDelegateTo: [], background: false, maxTurns: null };
    }
  },
}));

import { GET } from './route';

const req = (apiKey: string | null = 'bld_runner') =>
  new NextRequest(`http://localhost/api/workers/${WORKER}/prompt-bundles`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
const params = (id = WORKER) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  row = {
    id: WORKER,
    accountId: ACCOUNT,
    taskId: 'task-1',
    task: { id: 'task-1', workspaceId: 'ws-1', roleSlug: 'builder', context: { skillSlugs: ['ship'] }, workspace: { teamId: 'team-1' } },
  };
  authed = { id: ACCOUNT, level: 'worker' };
  attachCalls.length = 0;
});

describe('GET /api/workers/[id]/prompt-bundles', () => {
  it("returns the task's skill bundles, role config and persona — the claim's resolution", async () => {
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.skillBundles.map((b: any) => b.slug)).toEqual(['ship']);
    expect(body.roleConfig.configUrl).toBe('https://r2.example/presigned');
    expect(body.roleInstructions.slug).toBe('builder');
    // Resolved against the worker's own task and the owning account.
    expect(attachCalls.map(c => c.fn)).toEqual(['skills', 'role']);
    for (const c of attachCalls) {
      expect(c.accountId).toBe(ACCOUNT);
      expect(c.tasks[0].id).toBe('task-1');
      expect(c.cw.taskId).toBe('task-1');
    }
  });

  it('a task with no role and no skills answers with nothing to write', async () => {
    row!.task = { id: 'task-1', workspaceId: 'ws-1', roleSlug: null, context: {}, workspace: { teamId: 'team-1' } };
    const body = await (await GET(req(), params())).json() as any;
    expect(body).toEqual({});
  });

  it("another account's worker: 404 and nothing resolved", async () => {
    authed = { id: '55555555-5555-4555-8555-555555555555', level: 'worker' };
    expect((await GET(req(), params())).status).toBe(404);
    expect(attachCalls).toHaveLength(0);
  });

  it("a task token for a different task: 404", async () => {
    authed = { id: ACCOUNT, level: 'worker', taskScope: { taskId: 'task-2', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };
    expect((await GET(req(), params())).status).toBe(404);
  });

  it('auth: 401 without a key, 403 for a trigger key, 404 for a non-uuid or missing worker', async () => {
    authed = null;
    expect((await GET(req(null), params())).status).toBe(401);
    authed = { id: ACCOUNT, level: 'trigger' };
    expect((await GET(req(), params())).status).toBe(403);
    authed = { id: ACCOUNT, level: 'worker' };
    expect((await GET(req(), params('nope'))).status).toBe(404);
    row = null;
    expect((await GET(req(), params())).status).toBe(404);
  });
});

// Invariant: an OAuth session acts as an account its whole team shares, so
// only the session user that claimed the worker may re-fetch its role/skill
// payload (lib/worker-owner.ts). A teammate on the same account, an
// admin-level session that did not claim, and a session with no team id all
// get the same 404 as a stranger, and nothing is resolved.
describe('GET /api/workers/[id]/prompt-bundles — OAuth session owner check', () => {
  const session = (over: Partial<NonNullable<typeof authed>> = {}) =>
    ({ id: ACCOUNT, teamId: 'team-1', sessionUserId: 'user-a', level: 'worker', ...over });

  beforeEach(() => {
    row = { ...row!, workspaceId: 'ws-1', claimedByUserId: 'user-a' };
  });

  it('lets the session that claimed the worker fetch its bundles', async () => {
    authed = session();
    expect((await GET(req(), params())).status).toBe(200);
    expect(attachCalls.map(c => c.fn)).toEqual(['skills', 'role']);
  });

  it('404s a same-team member on the shared account and resolves nothing', async () => {
    authed = session({ sessionUserId: 'user-b' });
    expect((await GET(req(), params())).status).toBe(404);
    expect(attachCalls).toHaveLength(0);
  });

  it('404s an admin-level session that did not claim the worker', async () => {
    authed = session({ sessionUserId: 'user-b', level: 'admin' });
    expect((await GET(req(), params())).status).toBe(404);
    expect(attachCalls).toHaveLength(0);
  });

  it('404s a session with no team id, even as the claimer', async () => {
    authed = session({ teamId: null });
    expect((await GET(req(), params())).status).toBe(404);
    expect(attachCalls).toHaveLength(0);
  });
});

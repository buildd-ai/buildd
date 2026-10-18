/**
 * GET /api/workspaces/across/{list}: the skills list keeps the per-workspace
 * skills route's gate (an admin or tasks:read-scoped key, never a worker-level
 * key or a per-task token; the bulk-read guard on token callers), and the
 * other lists keep theirs (any key, a task token narrowed to its workspace).
 * SQL scoping is covered on real Postgres in tests/db/workspaces-across.test.ts.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: any = null;
let sessionUser: any = null;
let reachable: string[] = ['ws-a', 'ws-b'];
let rows: any[] = [];
let bodyReadAllowed = true;
const noted: { caller: string; ids: string[]; surface: string }[] = [];

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => sessionUser }));
mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: async () => caller,
  taskScopeAllowsWorkspace: (account: any, id: string) => !account.taskScope || account.taskScope.workspaceId === id,
}));
mock.module('@/lib/workspace-access', () => ({ listReachableWorkspaceIds: async () => reachable }));
mock.module('@/lib/body-read-monitor', () => ({
  noteBodyReads: async (c: string, ids: string[], surface: string) => { noted.push({ caller: c, ids, surface }); return { allowed: bodyReadAllowed, distinct: ids.length }; },
  bodyReadRefused: () => Response.json({ error: 'too many' }, { status: 429 }),
}));
mock.module('@/lib/artifact-scope', () => ({ reviewArtifactScope: () => ({}) }));
mock.module('@/lib/app-url', () => ({ appBaseUrl: () => 'https://example.test' }));

// Every select chain resolves to `rows`.
const chain: any = new Proxy(() => {}, {
  get: (_t, prop) => (prop === 'then' ? (res: (v: any) => void) => res(rows) : () => chain),
  apply: () => chain,
});
mock.module('@buildd/core/db', () => ({ db: { select: () => chain } }));

const { GET } = await import('./route');

const get = (list: string) => GET(
  new NextRequest(`http://localhost/api/workspaces/across/${list}`, { headers: { authorization: 'Bearer k' } }),
  { params: Promise.resolve({ list }) },
);

const admin = { id: 'acct-admin', level: 'admin', teamId: 't', scopes: null };
const worker = { id: 'acct-worker', level: 'worker', teamId: 't', scopes: null };
const taskToken = { id: 'acct-admin', level: 'admin', teamId: 't', scopes: null, taskScope: { workspaceId: 'ws-a', taskId: 'task-1' } };
const scopedReader = { id: 'acct-scoped', level: 'worker', teamId: 't', scopes: ['tasks:read'], workspaceIds: ['ws-a'] };

beforeEach(() => {
  caller = null; sessionUser = null; reachable = ['ws-a', 'ws-b']; bodyReadAllowed = true; noted.length = 0;
  rows = [{ id: 'sk-1', slug: 'a', workspaceId: 'ws-a' }, { id: 'sk-2', slug: 'b', workspaceId: 'ws-b' }];
});

describe('GET /api/workspaces/across/skills: the per-workspace skills gate', () => {
  it('refuses a worker-level key', async () => {
    caller = worker;
    expect((await get('skills')).status).toBe(401);
  });

  it('refuses a per-task token', async () => {
    caller = taskToken;
    expect((await get('skills')).status).toBe(401);
  });

  it('serves an admin key and counts the bodies it was handed', async () => {
    caller = admin;
    const res = await get('skills');
    expect(res.status).toBe(200);
    expect((await res.json()).skills.map((s: any) => s.id)).toEqual(['sk-1', 'sk-2']);
    expect(noted).toEqual([{ caller: 'acct-admin', ids: ['sk-1', 'sk-2'], surface: 'skills_list' }]);
  });

  it('serves a tasks:read-scoped key', async () => {
    caller = scopedReader;
    expect((await get('skills')).status).toBe(200);
  });

  it('answers 429 when the bulk-read guard refuses', async () => {
    caller = admin;
    bodyReadAllowed = false;
    expect((await get('skills')).status).toBe(429);
  });

  it('serves a session user without the token guard', async () => {
    sessionUser = { id: 'u1' };
    expect((await get('skills')).status).toBe(200);
    expect(noted).toEqual([]);
  });
});

describe('GET /api/workspaces/across/{artifacts,schedules}: the per-workspace gates', () => {
  it('serves a worker-level key, as the per-workspace routes do', async () => {
    caller = worker;
    rows = [];
    expect((await get('artifacts')).status).toBe(200);
    expect((await get('schedules')).status).toBe(200);
  });

  it('narrows a per-task token to its own workspace', async () => {
    caller = taskToken;
    rows = [];
    const body = await (await get('schedules')).json();
    expect(body.workspaceCount).toBe(1);
  });
});

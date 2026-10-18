/**
 * Who is calling, cached (lib/caller-cache.ts, spec 3ef37387 R-34, AC-9),
 * against real Postgres: the reads that resolve a caller go to the database
 * once, and each change that takes reach away is seen on the very next call,
 * well inside the 60 s TTL.
 *
 *  - AC-9: 100 MCP reads by one token (a `bld_` key, and an OAuth grant
 *    token) make no caller-resolution query after the first.
 *  - A grant revoke, a membership removal, a key rotation and a workspace
 *    access-mode change, each through the code that makes it, take effect on
 *    the next call while the caller's entries are still warm.
 *
 * Redis is an in-memory stand-in shared by the whole process (the generation
 * scheme is what is under test, not the Redis client); the database and every
 * query counted here are real. Illustrative rows only.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { recordNeonQueries } from '@buildd/core/db';
import { createFakeRedis } from '../../src/lib/caller-cache.fixtures';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

assertDbConfigured();

const redis = createFakeRedis();
const realRedis = await import('../../src/lib/redis');
mock.module('../../src/lib/redis', () => ({ ...realRedis, ...redis.module }));

// The writer routes act as a signed-in owner; MCP calls carry only a bearer.
let session: { id: string; email: string; name: string | null; image: null; timezone: null } | null = null;
const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({
  ...realAuthHelpers,
  getCurrentUser: async () => session,
  getRequestPrincipal: async () => (session ? { kind: 'session', user: session } : null),
  requireSessionUser: async () => (session
    ? { user: session }
    : { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }),
}));

process.env.AUTH_SECRET ||= 'caller-cache-db-test-secret-0123456789abcdef';
process.env.OAUTH_ISSUER = 'https://issuer.example';
process.env.NEXTAUTH_URL = 'http://self.example';
delete process.env.VERCEL_URL;

const grants = await import('../../src/lib/mcp-grants');
const tokens = await import('../../src/lib/oauth/tokens');
const storage = await import('../../src/lib/oauth/storage');
const { authenticateApiKey, clearAccountCache, hashApiKey } = await import('../../src/lib/api-auth');
const mcpRoute = await import('../../src/app/api/mcp/route');
const tasksRoute = await import('../../src/app/api/tasks/route');
const workspacesRoute = await import('../../src/app/api/workspaces/route');
const workspaceRoute = await import('../../src/app/api/workspaces/[id]/route');
const memberRoute = await import('../../src/app/api/teams/[id]/members/[userId]/route');
const regenerateKeyRoute = await import('../../src/app/api/accounts/[id]/regenerate-key/route');

/** The tables a caller is resolved from. A read action's own reads (tasks) are not on it. */
const CALLER_TABLES = new Set([
  'accounts', 'account_workspaces', 'team_members', 'teams', 'users', 'workspaces',
  'mcp_oauth_grants', 'task_delegations', 'task_schedules',
]);

// The MCP route's REST self-calls, served in-process by the real handlers.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== 'http://self.example') return realFetch(input as never, init);
  const req = new NextRequest(url, { method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body as BodyInit | undefined });
  if (url.pathname === '/api/tasks' && req.method === 'GET') return tasksRoute.GET(req as never) as Promise<Response>;
  return Response.json({ error: 'not routed in this test' }, { status: 404 });
}) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

beforeAll(() => {
  redis.reset();
  clearAccountCache();
});

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

async function user(): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`cc-${rand()}@example.test`}) RETURNING id`);
  return u.id;
}
async function member(teamId: string, userId: string, role: 'owner' | 'admin' | 'member') {
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${userId}::uuid, ${role})`);
}
async function setAccess(workspaceId: string, mode: 'open' | 'restricted') {
  await q(sql`UPDATE workspaces SET access_mode = ${mode} WHERE id = ${workspaceId}::uuid`);
}
/** A `bld_` key of `teamId`; linked to `linkTo` when given. */
async function apiKey(teamId: string, o: { linkTo?: string; level?: 'worker' | 'admin' } = {}): Promise<{ key: string; accountId: string }> {
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}${rand()}`;
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, api_key_prefix, team_id, level, auth_type)
    VALUES ('user', ${`cc-${rand()}`}, ${hashApiKey(key)}, ${key.slice(0, 12)}, ${teamId}::uuid, ${o.level ?? 'worker'}, 'api') RETURNING id`);
  if (o.linkTo) {
    await q(sql`INSERT INTO account_workspaces (account_id, workspace_id, can_claim, can_create) VALUES (${a.id}::uuid, ${o.linkTo}::uuid, true, true)`);
  }
  return { key, accountId: a.id };
}
/** The team account a grant session acts as (lib/oauth/session-account.ts). */
async function sessionAccount(teamId: string) {
  const k = `k-${rand()}`;
  await q(sql`INSERT INTO accounts (type, name, api_key, team_id, auth_type) VALUES ('user', ${k}, ${k}, ${teamId}::uuid, 'oauth')`);
}
async function grantToken(userId: string, workspaceIds: string[]): Promise<{ jwt: string; grantId: string }> {
  const { clientId } = await storage.createClient({ clientName: 'caller-cache test', redirectUris: ['https://client.example/cb'] });
  const r = await grants.createGrant({ userId, clientId, actsAs: 'person', workspaceIds, scopes: ['read', 'write'] });
  if (!r.ok) throw new Error(`createGrant: ${r.error}`);
  const { token } = await tokens.signGrantAccessToken({ userId, grantId: r.grantId, clientId, scope: 'mcp' });
  return { jwt: token, grantId: r.grantId };
}

let rpcId = 0;
function mcp(bearer: string, body: Record<string, unknown>, query = ''): Promise<Response> {
  return mcpRoute.POST(new Request(`http://localhost/api/mcp${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, ...body }),
  }));
}
const listTools = (bearer: string) => mcp(bearer, { method: 'tools/list' });
const listTasks = (bearer: string, workspaceId: string) =>
  mcp(bearer, { method: 'tools/call', params: { name: 'buildd_tasks', arguments: { action: 'list_tasks', params: { workspaceId } } } });

/** Run `fn` and return what it read from the caller tables, and everything it read. */
async function readsOf(fn: () => Promise<unknown>) {
  const rec = await recordNeonQueries(async () => { await fn(); });
  const callerReads = rec.queries.filter((x) => x.table && CALLER_TABLES.has(x.table)).map((x) => `${x.table}: ${x.head}`);
  return { callerReads, tables: rec.queries.map((x) => x.table) };
}

const asOwner = async <T>(ownerId: string, fn: () => Promise<T>): Promise<T> => {
  session = { id: ownerId, email: `${ownerId}@example.test`, name: null, image: null, timezone: null };
  try { return await fn(); } finally { session = null; }
};
const jsonReq = (url: string, method: string, body?: unknown) =>
  new NextRequest(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('AC-9: 100 MCP reads by one token, no caller-resolution query after the first', () => {
  test('a bld_ key', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    await seedTask(workspaceId, { status: 'pending', title: 'cached caller read' });
    const { key } = await apiKey(teamId, { linkTo: workspaceId });

    const first = await listTasks(key, workspaceId);
    expect(first.status).toBe(200);
    expect(JSON.stringify(await first.json())).toContain('cached caller read');

    const later = await readsOf(async () => {
      for (let i = 0; i < 50; i++) {
        expect((await listTools(key)).status).toBe(200);
        const res = await listTasks(key, workspaceId);
        expect(res.status).toBe(200);
        expect(JSON.stringify(await res.json())).toContain('cached caller read');
      }
    });
    expect(later.callerReads).toEqual([]);
    // They really are reads: the task list came from the database each time.
    expect(later.tables.filter((t) => t === 'tasks').length).toBeGreaterThanOrEqual(50);
  }, 120_000);

  test('an OAuth grant token', async () => {
    const userId = await user();
    const { teamId, workspaceId } = await seedWorkspace();
    await member(teamId, userId, 'member');
    await sessionAccount(teamId);
    const { jwt } = await grantToken(userId, [workspaceId]);

    expect((await listTools(jwt)).status).toBe(200);
    const later = await readsOf(async () => {
      for (let i = 0; i < 100; i++) expect((await listTools(jwt)).status).toBe(200);
    });
    expect(later.callerReads).toEqual([]);
  }, 120_000);
});

describe('a change that takes reach away is seen on the next call', () => {
  test('a grant revoke', async () => {
    const userId = await user();
    const { teamId, workspaceId } = await seedWorkspace();
    await member(teamId, userId, 'member');
    await sessionAccount(teamId);
    const { jwt, grantId } = await grantToken(userId, [workspaceId]);

    expect((await listTools(jwt)).status).toBe(200);
    // Warm: answered from the cache.
    expect((await readsOf(() => listTools(jwt))).callerReads).toEqual([]);

    expect(await grants.revokeGrant(grantId, userId)).toBe(true);
    expect((await listTools(jwt)).status).toBe(401);
  });

  test('a membership removal (DELETE /api/teams/[id]/members/[userId])', async () => {
    const ownerId = await user();
    const userId = await user();
    const { teamId, workspaceId } = await seedWorkspace();
    await member(teamId, ownerId, 'owner');
    await member(teamId, userId, 'member');
    await sessionAccount(teamId);
    const { jwt } = await grantToken(userId, [workspaceId]);

    expect((await listTools(jwt)).status).toBe(200);
    expect((await readsOf(() => listTools(jwt))).callerReads).toEqual([]);

    const res = await asOwner(ownerId, () => memberRoute.DELETE(
      jsonReq(`http://localhost/api/teams/${teamId}/members/${userId}`, 'DELETE'),
      { params: Promise.resolve({ id: teamId, userId }) },
    ));
    expect(res.status).toBe(200);
    expect((await listTools(jwt)).status).toBe(401);
  });

  test('a key rotation (POST /api/accounts/[id]/regenerate-key)', async () => {
    const ownerId = await user();
    const { teamId, workspaceId } = await seedWorkspace();
    await member(teamId, ownerId, 'owner');
    const { key, accountId } = await apiKey(teamId, { linkTo: workspaceId });

    expect((await listTools(key)).status).toBe(200);
    expect((await readsOf(() => listTools(key))).callerReads).toEqual([]);

    const res = await asOwner(ownerId, () => regenerateKeyRoute.POST(
      jsonReq(`http://localhost/api/accounts/${accountId}/regenerate-key`, 'POST'),
      { params: Promise.resolve({ id: accountId }) },
    ));
    expect(res.status).toBe(200);
    const { apiKey: rotated } = await res.json() as { apiKey: string };

    expect((await listTools(key)).status).toBe(401);
    expect(await authenticateApiKey(key)).toBeNull();
    expect((await listTools(rotated)).status).toBe(200);
  });

  test('a workspace access-mode change (PATCH /api/workspaces/[id]): restricted drops a same-team key with no link', async () => {
    const ownerId = await user();
    const { teamId, workspaceId } = await seedWorkspace();
    await setAccess(workspaceId, 'open');
    await member(teamId, ownerId, 'owner');
    const { key } = await apiKey(teamId);
    const listWorkspaces = async () => {
      const res = await workspacesRoute.GET(new NextRequest('http://localhost/api/workspaces', { headers: { authorization: `Bearer ${key}` } }));
      expect(res.status).toBe(200);
      const body = await res.json() as { workspaces: Array<{ id: string }> };
      return body.workspaces.map((w) => w.id);
    };

    expect(await listWorkspaces()).toContain(workspaceId);
    // Warm: the key, its links and its team's open workspaces come from the
    // cache. What is left is the listing's own read of the rows it returns.
    const warm = await readsOf(listWorkspaces);
    expect(warm.callerReads.filter((r) => !r.startsWith('workspaces: select d0.id as id, d0.name'))).toEqual([]);

    const patch = (accessMode: 'open' | 'restricted') => asOwner(ownerId, () => workspaceRoute.PATCH(
      jsonReq(`http://localhost/api/workspaces/${workspaceId}`, 'PATCH', { accessMode }),
      { params: Promise.resolve({ id: workspaceId }) },
    ));
    expect((await patch('restricted')).status).toBe(200);
    expect(await listWorkspaces()).not.toContain(workspaceId);

    // And back: "not reachable" was cached too, and opening it is seen at once.
    await listWorkspaces();
    expect((await patch('open')).status).toBe(200);
    expect(await listWorkspaces()).toContain(workspaceId);
  });
});

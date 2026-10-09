/**
 * The canonical account-level MCP transport (/api/mcp on a grant token)
 * against real Postgres (docs/specs/auth-oauth-boundaries.md, "Canonical MCP
 * transport").
 *
 * A grant token names a grant, never a workspace. Every request is resolved to
 * the grant's workspaces ∩ the user's current memberships and served in
 * exactly one of them: the one the call names, matched among granted
 * workspaces only. A mocked `db` would hide every predicate that decides this,
 * so the scoping here runs on real rows:
 *  - list_workspaces lists granted ∩ membership across teams, nothing else;
 *  - no workspace on a multi-workspace grant, an ambiguous name, or an
 *    ungranted id are refused with granted choices only, never an ungranted id;
 *  - a multi-team grant acts in the named workspace's team, and its REST
 *    self-calls are confined to that one workspace;
 *  - a read-only grant cannot write, on MCP or REST;
 *  - an agent grant is still refused by a person-only action;
 *  - a legacy per-workspace token keeps working on its endpoint, with the
 *    deprecation notice;
 *  - a bldt_ task token is not widened by the workspace binding.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';
import { world, type World } from './workflow-scenarios-world';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

process.env.AUTH_SECRET ||= 'mcp-canonical-transport-test-secret-0123456789';
process.env.OAUTH_ISSUER = 'https://issuer.example';
process.env.NEXTAUTH_URL = 'http://self.example';
delete process.env.VERCEL_URL;

const grants = await import('../../src/lib/mcp-grants');
const tokens = await import('../../src/lib/oauth/tokens');
const storage = await import('../../src/lib/oauth/storage');
const { authenticateApiKey, clearAccountCache, GRANT_WORKSPACE_HEADER } = await import('../../src/lib/api-auth');
const { authenticateTaskScopedCaller } = await import('../../src/lib/task-token-auth');
const { mintTaskToken } = await import('../../src/lib/task-token');
const { requestingPerson } = await import('../../src/lib/request-person');
const mcpRoute = await import('../../src/app/api/mcp/route');
const legacyRoute = await import('../../src/app/api/mcp-oauth/[workspace]/route');
const taskRoute = await import('../../src/app/api/tasks/[id]/route');
const closedPrsRoute = await import('../../src/app/api/missions/[id]/closed-prs/route');

beforeAll(() => assertDbConfigured());

// Self-calls from the MCP route go over HTTP to the app's own base URL. Route
// them in-process to the real handlers so the binding they carry is what the
// REST layer actually sees.
const realFetch = globalThis.fetch;
const selfCalls: Array<{ path: string; bound: string | null }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== 'http://self.example') return realFetch(input as never, init);
  const headers = new Headers(init?.headers);
  selfCalls.push({ path: url.pathname, bound: headers.get(GRANT_WORKSPACE_HEADER) });
  const req = new NextRequest(url, { method: init?.method ?? 'GET', headers, body: init?.body as BodyInit | undefined });
  const m = /^\/api\/tasks\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (m && req.method === 'GET') return taskRoute.GET(req as never, { params: Promise.resolve({ id: m[1] }) }) as Promise<Response>;
  return new Response(JSON.stringify({ error: 'not routed in this test' }), { status: 404 });
}) as typeof fetch;

let w: World | undefined;
afterEach(() => { w?.dispose(); w = undefined; clearAccountCache(); selfCalls.length = 0; });

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

async function user(): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  return u.id;
}
async function member(teamId: string, userId: string, role = 'member') {
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${userId}::uuid, ${role})`);
}
async function teamAccount(teamId: string): Promise<string> {
  const key = `k-${rand()}`;
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, auth_type) VALUES ('user', ${key}, ${key}, ${teamId}::uuid, 'oauth') RETURNING id`);
  return a.id;
}
async function client(): Promise<string> {
  const { clientId } = await storage.createClient({ clientName: 'test', redirectUris: ['https://client.example/cb'] });
  return clientId;
}
async function grantToken(o: { userId: string; clientId: string; actsAs: 'person' | 'agent'; workspaceIds: string[]; scopes?: Array<'read' | 'write'> }) {
  const r = await grants.createGrant({ ...o, scopes: o.scopes ?? ['read', 'write'] });
  if (!r.ok) throw new Error(`createGrant: ${r.error}`);
  return (await tokens.signGrantAccessToken({ userId: o.userId, grantId: r.grantId, clientId: o.clientId, scope: 'mcp' })).token;
}
/** Open to its team's accounts, as a workspace a team shares normally is. */
async function open(workspaceId: string) {
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${workspaceId}::uuid`);
}
async function rename(workspaceId: string, name: string) {
  await q(sql`UPDATE workspaces SET name = ${name} WHERE id = ${workspaceId}::uuid`);
}

/**
 * Two teams the user is in (owner of A, member of B), one granted workspace
 * each, an ungranted sibling in A, and a team the user is not in.
 */
async function setup(o: { actsAs?: 'person' | 'agent'; scopes?: Array<'read' | 'write'> } = {}) {
  const userId = await user();
  const a = await seedWorkspace();
  const b = await seedWorkspace();
  const outside = await seedWorkspace();
  const [sib] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id) VALUES (${`sib-${rand()}`}, ${a.teamId}::uuid) RETURNING id`);
  for (const id of [a.workspaceId, b.workspaceId, sib.id, outside.workspaceId]) await open(id);
  await member(a.teamId, userId, 'owner');
  await member(b.teamId, userId, 'member');
  await teamAccount(a.teamId);
  await teamAccount(b.teamId);
  const clientId = await client();
  const jwt = await grantToken({ userId, clientId, actsAs: o.actsAs ?? 'person', workspaceIds: [a.workspaceId, b.workspaceId], scopes: o.scopes });
  return { userId, a, b, outside, sibling: sib.id, clientId, jwt };
}

let rpcId = 0;
async function mcp(jwt: string | null, body: Record<string, unknown>, query = ''): Promise<Response> {
  return mcpRoute.POST(new Request(`http://localhost/api/mcp${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, ...body }),
  }));
}
async function callTool(jwt: string, args: Record<string, unknown>, query = '', name = 'buildd') {
  const res = await mcp(jwt, { method: 'tools/call', params: { name, arguments: args } }, query);
  const body = await res.json() as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: unknown };
  return { status: res.status, text: body.result?.content?.[0]?.text ?? JSON.stringify(body), isError: body.result?.isError === true };
}

describe('discovery', () => {
  test('an unauthenticated call points at the account-level protected-resource metadata', async () => {
    const res = await mcp(null, { method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata="https://issuer.example/.well-known/oauth-protected-resource/api/mcp"');
  });

  test('an invalid credential gets the same challenge; the advertised metadata names exactly <issuer>/api/mcp', async () => {
    for (const bad of ['bld_not-a-real-key', 'eyJhbGciOiJIUzI1NiJ9.e30.x']) {
      const res = await mcp(bad, { method: 'tools/list' });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/api/mcp"');
    }
    // What a client (the runner's plugin installer) probes: follow the
    // challenge's metadata URL; its resource is exactly the canonical endpoint.
    const challenge = (await mcp(null, { method: 'tools/list' })).headers.get('www-authenticate')!;
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)![1];
    expect(new URL(metadataUrl).pathname).toBe('/.well-known/oauth-protected-resource/api/mcp');
    const prm = await import('../../src/app/.well-known/oauth-protected-resource/api/mcp/route');
    const meta = await (await prm.GET()).json() as { resource: string; scopes_supported: string[] };
    expect(meta.resource).toBe('https://issuer.example/api/mcp');
    expect(meta.scopes_supported).not.toContain('buildd:act-as-person');
  });

  test('a token for that resource is accepted, as the person or as the agent per the grant', async () => {
    for (const actsAs of ['person', 'agent'] as const) {
      const s = await setup({ actsAs });
      const res = await mcp(s.jwt, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      expect(res.status).toBe(200);
      const { result } = await res.json() as { result: { instructions: string } };
      expect(result.instructions).toContain(actsAs === 'person' ? ', as you.' : 'as your agent');
      const acct = await authenticateGrantSessionFor(s.jwt, s.a.workspaceId);
      expect(requestingPerson(null, acct)).toBe(actsAs === 'person' ? s.userId : null);
    }
  });

  test('list_workspaces lists granted ∩ membership across teams, and nothing else', async () => {
    const s = await setup();
    const r = await callTool(s.jwt, { action: 'list_workspaces' });
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.text) as { total: number; teams: Array<{ teamId: string; workspaces: Array<{ id: string; level: string; access: string }> }> };
    expect(out.total).toBe(2);
    const listed = out.teams.flatMap((t) => t.workspaces.map((x) => ({ ...x, teamId: t.teamId })));
    expect(listed.map((x) => x.id).sort()).toEqual([s.a.workspaceId, s.b.workspaceId].sort());
    expect(listed.find((x) => x.id === s.a.workspaceId)).toMatchObject({ teamId: s.a.teamId, level: 'admin', access: 'read-write' });
    expect(listed.find((x) => x.id === s.b.workspaceId)).toMatchObject({ teamId: s.b.teamId, level: 'worker', access: 'read-write' });
    for (const id of [s.sibling, s.outside.workspaceId, s.outside.teamId]) expect(r.text).not.toContain(id);

    // Membership loss drops that team on the very next call.
    await q(sql`DELETE FROM team_members WHERE team_id = ${s.b.teamId}::uuid AND user_id = ${s.userId}::uuid`);
    const after = JSON.parse((await callTool(s.jwt, { action: 'list_workspaces' })).text) as { total: number };
    expect(after.total).toBe(1);
  });

  test('list_workspaces pages', async () => {
    const s = await setup();
    const first = JSON.parse((await callTool(s.jwt, { action: 'list_workspaces', params: { limit: 1 } })).text) as { nextOffset: number | null; teams: unknown[] };
    expect(first.nextOffset).toBe(1);
    const second = JSON.parse((await callTool(s.jwt, { action: 'list_workspaces', params: { limit: 1, offset: 1 } })).text) as { nextOffset: number | null };
    expect(second.nextOffset).toBeNull();
  });

  test('the server instructions say how to pick a workspace', async () => {
    const s = await setup();
    const res = await mcp(s.jwt, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const body = await res.json() as { result: { instructions: string } };
    expect(body.result.instructions).toContain('list_workspaces');
    expect(body.result.instructions).toContain('across 2 teams');
  });
});

describe('strict workspace resolution', () => {
  test('no workspaceId on a multi-workspace grant is refused with the granted choices only', async () => {
    const s = await setup();
    const r = await callTool(s.jwt, { action: 'create_task', params: { title: 't', description: 'd', kind: 'engineering' } });
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.text) as { error: string; choices: Array<{ workspaceId: string }> };
    expect(body.error).toBe('workspace_required');
    expect(body.choices.map((c) => c.workspaceId).sort()).toEqual([s.a.workspaceId, s.b.workspaceId].sort());
    for (const id of [s.sibling, s.outside.workspaceId]) expect(r.text).not.toContain(id);
    expect(selfCalls).toEqual([]);
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM tasks WHERE workspace_id IN (${s.a.workspaceId}::uuid, ${s.b.workspaceId}::uuid) AND title = 't'`);
    expect(n).toBe(0);
  });

  test('an ambiguous name returns only the granted matches, never an ungranted namesake', async () => {
    const s = await setup();
    const dup = `dup-${rand()}`;
    await rename(s.a.workspaceId, dup);
    await rename(s.b.workspaceId, dup);
    await rename(s.sibling, dup);
    await rename(s.outside.workspaceId, dup);
    const r = await callTool(s.jwt, { action: 'list_tasks', params: { workspaceId: dup } });
    const body = JSON.parse(r.text) as { error: string; choices: Array<{ workspaceId: string }> };
    expect(body.error).toBe('workspace_ambiguous');
    expect(body.choices.map((c) => c.workspaceId).sort()).toEqual([s.a.workspaceId, s.b.workspaceId].sort());
    for (const id of [s.sibling, s.outside.workspaceId]) expect(r.text).not.toContain(id);
  });

  test('a name unique among granted workspaces resolves, even when an ungranted workspace shares it', async () => {
    const s = await setup();
    const taskB = await seedTask(s.b.workspaceId, { title: `tb-${rand()}` }); 
    const name = `only-${rand()}`;
    await rename(s.b.workspaceId, name);
    await rename(s.sibling, name);
    await rename(s.outside.workspaceId, name);
    const r = await callTool(s.jwt, { action: 'get_task', params: { taskId: taskB, workspaceId: name } });
    expect(r.isError).toBe(false);
    // The self-call carried the resolved id, never the name.
    expect(selfCalls.map((c) => c.bound)).toEqual([s.b.workspaceId]);
  });

  test('an ungranted or unknown workspace id is refused without echoing it', async () => {
    const s = await setup();
    for (const ref of [s.sibling, s.outside.workspaceId, crypto.randomUUID()]) {
      const r = await callTool(s.jwt, { action: 'list_tasks', params: { workspaceId: ref } });
      expect(JSON.parse(r.text).error).toBe('workspace_not_granted');
      expect(r.text).not.toContain(ref);
    }
    // The same through the connection URL: one generic 403.
    const res = await mcp(s.jwt, { method: 'tools/list' }, `?workspace=${s.outside.workspaceId}`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(s.outside.workspaceId);
  });

  test('a grant with one workspace needs no workspaceId', async () => {
    const userId = await user();
    const a = await seedWorkspace();
    await open(a.workspaceId);
    await member(a.teamId, userId, 'member');
    await teamAccount(a.teamId);
    const jwt = await grantToken({ userId, clientId: await client(), actsAs: 'person', workspaceIds: [a.workspaceId] });
    const taskId = await seedTask(a.workspaceId, { title: `ta-${rand()}` }); 
    const r = await callTool(jwt, { action: 'get_task', params: { taskId } });
    expect(r.isError).toBe(false);
    expect(selfCalls.map((c) => c.bound)).toEqual([a.workspaceId]);
  });
});

describe('per-request resolution of a multi-team grant', () => {
  test('acts in the named workspace\'s team at the role there, confined to that workspace', async () => {
    const s = await setup();
    // A grant session is workspace-confined on REST: a collection read names its workspace.
    const bound = (id: string) => new Request(`http://localhost/api/tasks?workspaceId=${id}`, { headers: { [GRANT_WORKSPACE_HEADER]: id } });
    const inA = await authenticateApiKey(s.jwt, bound(s.a.workspaceId)) as Record<string, unknown> | null;
    expect(inA).toMatchObject({ teamId: s.a.teamId, level: 'admin', workspaceIds: [s.a.workspaceId] });
    const inB = await authenticateApiKey(s.jwt, bound(s.b.workspaceId)) as Record<string, unknown> | null;
    expect(inB).toMatchObject({ teamId: s.b.teamId, level: 'worker', workspaceIds: [s.b.workspaceId] });
    // Unbound, ungranted, foreign or garbage: no session at all.
    expect(await authenticateApiKey(s.jwt, new Request('http://localhost/api/tasks'))).toBeNull();
    for (const id of [s.sibling, s.outside.workspaceId, 'not-a-uuid']) expect(await authenticateApiKey(s.jwt, bound(id))).toBeNull();
  });

  test('a call in B reaches B\'s task; naming B for A\'s task reaches nothing', async () => {
    const s = await setup();
    const tA = await seedTask(s.a.workspaceId, { title: `ta-${rand()}` }); 
    const tB = await seedTask(s.b.workspaceId, { title: `tb-${rand()}` }); 
    const idA = tA, idB = tB;

    const ok = await callTool(s.jwt, { action: 'get_task', params: { taskId: idB, workspaceId: s.b.workspaceId } });
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain(idB);

    const cross = await callTool(s.jwt, { action: 'get_task', params: { taskId: idA, workspaceId: s.b.workspaceId } });
    expect(cross.text).not.toContain(idA.slice(0, 8) + ' ');
    expect(cross.text.toLowerCase()).toMatch(/not found|unauthorized|401|404/);
    expect(selfCalls.every((c) => c.bound === s.b.workspaceId)).toBe(true);
  });

  test('on a one-team grant, a binding to an ungranted workspace of that team is no session', async () => {
    const s = await setup();
    const jwt = await grantToken({ userId: s.userId, clientId: s.clientId, actsAs: 'person', workspaceIds: [s.a.workspaceId] });
    // A grant session is workspace-confined on REST: a collection read names its workspace.
    const bound = (id: string) => new Request(`http://localhost/api/tasks?workspaceId=${id}`, { headers: { [GRANT_WORKSPACE_HEADER]: id } });
    expect(await authenticateApiKey(jwt, bound(s.a.workspaceId))).not.toBeNull();
    expect(await authenticateApiKey(jwt, bound(s.sibling))).toBeNull();
  });

  test('a legacy per-workspace token ignores the binding and keeps its historical reach', async () => {
    const s = await setup();
    const { token } = await tokens.signAccessToken({ userId: s.userId, workspaceId: s.a.workspaceId, clientId: s.clientId, scope: 'mcp' });
    const acct = await authenticateApiKey(token, new Request('http://localhost/api/tasks', { headers: { [GRANT_WORKSPACE_HEADER]: s.b.workspaceId } })) as Record<string, unknown> | null;
    expect(acct).toMatchObject({ teamId: s.a.teamId, workspaceIds: null });
  });
});

describe('scopes', () => {
  test('a read-only grant reads but cannot write, on MCP and on REST', async () => {
    const s = await setup({ scopes: ['read'] });
    const write = await callTool(s.jwt, { action: 'create_task', params: { workspaceId: s.a.workspaceId, title: 't', description: 'd', kind: 'engineering' } });
    expect(write.isError).toBe(true);
    expect(JSON.parse(write.text)).toMatchObject({ error: 'forbidden', requiredScope: 'tasks:write' });
    expect(selfCalls).toEqual([]);

    const listed = JSON.parse((await callTool(s.jwt, { action: 'list_workspaces' })).text) as { teams: Array<{ workspaces: Array<{ access: string }> }> };
    expect(listed.teams.flatMap((t) => t.workspaces).every((x) => x.access === 'read')).toBe(true);

    const id = await seedTask(s.a.workspaceId, { title: `ta-${rand()}` });
    expect((await callTool(s.jwt, { action: 'get_task', params: { taskId: id, workspaceId: s.a.workspaceId } })).isError).toBe(false);

    const bound = { [GRANT_WORKSPACE_HEADER]: s.a.workspaceId, 'content-type': 'application/json' };
    expect(await authenticateApiKey(s.jwt, new Request(`http://localhost/api/tasks/${id}`, { headers: bound }))).not.toBeNull();
    expect(await authenticateApiKey(s.jwt, new Request('http://localhost/api/tasks', {
      method: 'POST', headers: bound, body: JSON.stringify({ workspaceId: s.a.workspaceId, title: 't' }),
    }))).toBeNull();
  });

  test('a write grant writes in the bound workspace only', async () => {
    const s = await setup();
    const bound = { [GRANT_WORKSPACE_HEADER]: s.b.workspaceId, 'content-type': 'application/json' };
    const post = (workspaceId: string) => new Request('http://localhost/api/tasks', { method: 'POST', headers: bound, body: JSON.stringify({ workspaceId, title: 't' }) });
    expect(await authenticateApiKey(s.jwt, post(s.b.workspaceId))).not.toBeNull();
    expect(await authenticateApiKey(s.jwt, post(s.a.workspaceId))).toBeNull();
  });
});

describe('the acts-as kind survives the canonical transport', () => {
  async function grantedWorld(actsAs: 'person' | 'agent') {
    w = await world();
    const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w.workspaceId}::uuid`);
    const other = await seedWorkspace();
    const userId = await user();
    await member(ws.team_id, userId, 'owner');
    await member(other.teamId, userId, 'owner');
    await teamAccount(ws.team_id);
    await teamAccount(other.teamId);
    // A grant spanning two teams: only the bound workspace makes it a session.
    const jwt = await grantToken({ userId, clientId: await client(), actsAs, workspaceIds: [w.workspaceId, other.workspaceId] });
    return { w, teamId: ws.team_id, userId, jwt };
  }

  async function closedPrInMission(w: World, teamId: string) {
    const pr = await w.openPr({ branch: `feat/c-${rand()}`, files: { 'src/a.ts': 'export const a = 2;\n' } });
    const missionId = await seedMission(teamId, w.workspaceId);
    await q(sql`UPDATE tasks SET mission_id = ${missionId}::uuid WHERE id = ${pr.ownerTaskId}::uuid`);
    w.gh.closePr(w.repo, pr.prNumber);
    await w.deliver();
    return { pr, missionId };
  }

  // Exactly what the canonical transport's self-call sends: the grant token
  // plus the workspace binding.
  const abandon = (missionId: string, taskId: string, jwt: string, workspaceId: string) => closedPrsRoute.POST(new NextRequest(`http://localhost/api/missions/${missionId}/closed-prs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}`, [GRANT_WORKSPACE_HEADER]: workspaceId },
    body: JSON.stringify({ taskId, action: 'abandon', reason: 'plan changed' }),
  }) as never, { params: Promise.resolve({ id: missionId }) });

  test('an agent grant bound to a workspace is still not a person, and cannot Abandon', async () => {
    const g = await grantedWorld('agent');
    const acct = await authenticateGrantSessionFor(g.jwt, g.w.workspaceId);
    expect(acct?.actsAs).toBe('agent');
    expect(acct?.sessionUserId).toBeUndefined();
    expect(requestingPerson(null, acct)).toBeNull();
    const { pr, missionId } = await closedPrInMission(g.w, g.teamId);
    const res = await abandon(missionId, pr.ownerTaskId, g.jwt, g.w.workspaceId);
    expect(res.status).toBe(403);
    expect((await g.w.delivery(pr)).state).toBe('CLOSED_UNMERGED');
  }, 60_000);

  test('a person grant bound to a workspace can Abandon, as that person', async () => {
    const g = await grantedWorld('person');
    const { pr, missionId } = await closedPrInMission(g.w, g.teamId);
    const res = await abandon(missionId, pr.ownerTaskId, g.jwt, g.w.workspaceId);
    expect(res.status).toBe(200);
    expect((await g.w.delivery(pr)).state).toBe('ABANDONED');
  }, 60_000);
});

async function authenticateGrantSessionFor(jwt: string, workspaceId: string) {
  const { authenticateGrantSession } = await import('../../src/lib/api-auth');
  return authenticateGrantSession(jwt, workspaceId) as Promise<(Record<string, unknown> & { actsAs?: string; sessionUserId?: string }) | null>;
}

describe('other credentials are not widened', () => {
  test('a legacy per-workspace token still works on its endpoint, with the deprecation notice', async () => {
    const s = await setup();
    const { token } = await tokens.signAccessToken({ userId: s.userId, workspaceId: s.a.workspaceId, clientId: s.clientId, scope: 'mcp' });
    const res = await legacyRoute.POST(new Request(`http://localhost/api/mcp-oauth/${s.a.workspaceId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    }), { params: Promise.resolve({ workspace: s.a.workspaceId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('deprecation')).toBe('true');
    expect(res.headers.get('link')).toBe('<https://issuer.example/api/mcp>; rel="successor-version"');
    const body = await res.json() as { result: { instructions: string } };
    expect(body.result.instructions).toContain('Deprecated endpoint');
    expect(body.result.instructions).toContain('/api/mcp');
  });

  test('a grant token is still refused on the per-workspace endpoint', async () => {
    const s = await setup();
    const res = await legacyRoute.POST(new Request(`http://localhost/api/mcp-oauth/${s.a.workspaceId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${s.jwt}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), { params: Promise.resolve({ workspace: s.a.workspaceId }) });
    expect(res.status).toBe(401);
  });

  test('a bldt_ task token stays bound to its own workspace, whatever binding it sends', async () => {
    const s = await setup();
    const key = `bld_${rand()}${rand()}`;
    const hash = new Bun.CryptoHasher('sha256').update(key).digest('hex');
    const [runner] = await q<{ id: string }>(sql`
      INSERT INTO accounts (type, name, api_key, team_id, level) VALUES ('service', ${`svc-${rand()}`}, ${hash}, ${s.a.teamId}::uuid, 'worker') RETURNING id`);
    const taskId = await seedTask(s.a.workspaceId, { title: `ta-${rand()}` });
    const minted = mintTaskToken({ accountId: runner.id, taskId, workspaceId: s.a.workspaceId, keyHash: hash });
    expect(minted).not.toBeNull();
    const req = new Request('http://localhost/api/tasks', { headers: { [GRANT_WORKSPACE_HEADER]: s.b.workspaceId } });
    const acct = await authenticateTaskScopedCaller(minted!.token, req);
    expect(acct?.taskScope?.workspaceId).toBe(s.a.workspaceId);
    expect(acct?.teamId).toBe(s.a.teamId);
    // Never an account key either, binding or not.
    expect(await authenticateApiKey(minted!.token, req)).toBeNull();
    // And on /api/mcp it still cannot name another workspace.
    const res = await mcp(minted!.token, { method: 'tools/list' }, `?workspace=${s.b.workspaceId}&worker=${crypto.randomUUID()}`);
    expect(res.status).toBe(403);
  });
});

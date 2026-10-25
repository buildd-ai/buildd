/**
 * Whole-team access on account-level MCP connections, against real Postgres
 * (docs/specs/oauth-provider-and-jwks.md, "Team access modes").
 *
 * A grant reaches, per team, either all current and future workspaces (a
 * mcp_oauth_grant_teams row, the default for a new consent) or specific
 * workspaces (mcp_oauth_grant_workspaces rows, what every grant made before
 * whole-team access has). Through real SQL, the real caller cache (an
 * in-memory Redis stand-in, so entries are warm) and the real routes:
 *  - a whole-team grant reaches every non-internal workspace of that team and
 *    nothing of another team, even one the user is on;
 *  - a workspace created in the team, or moved into it, is reached on the next
 *    request on the same access token, with the cache warm; one moved out or
 *    deleted is not;
 *  - membership loss, revoke and expiry end access on the next request;
 *  - a grant with specific workspaces only is unchanged by any of that;
 *  - Settings switches a team between modes on the same token, freezes
 *    exactly the reviewed selection, refuses a removal a whole-team choice
 *    still covers, refuses a forged team or a stale revision without writing,
 *    and records every change with its actor.
 * Illustrative rows only.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createFakeRedis } from '../../src/lib/caller-cache.fixtures';
import { assertDbConfigured, q, seedWorkspace } from './harness';

assertDbConfigured();

const redis = createFakeRedis();
const realRedis = await import('../../src/lib/redis');
mock.module('../../src/lib/redis', () => ({ ...realRedis, ...redis.module }));

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

process.env.AUTH_SECRET ||= 'mcp-grant-team-access-test-secret-0123456789';
process.env.OAUTH_ISSUER = 'https://issuer.example';
process.env.NEXTAUTH_URL = 'http://self.example';
delete process.env.VERCEL_URL;

const grants = await import('../../src/lib/mcp-grants');
const tokens = await import('../../src/lib/oauth/tokens');
const storage = await import('../../src/lib/oauth/storage');
const { clearAccountCache } = await import('../../src/lib/api-auth');
const { clearCallerCache, callerDep } = await import('../../src/lib/caller-cache');
const mcpRoute = await import('../../src/app/api/mcp/route');
const workspacesRoute = await import('../../src/app/api/workspaces/route');
const workspaceRoute = await import('../../src/app/api/workspaces/[id]/route');
const memberRoute = await import('../../src/app/api/teams/[id]/members/[userId]/route');
const grantRoute = await import('../../src/app/api/mcp-grants/[id]/route');
const listRoute = await import('../../src/app/api/mcp-grants/route');

beforeAll(() => { redis.reset(); clearAccountCache(); });
afterEach(() => { session = null; });

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

async function user(): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`ta-${rand()}@example.test`}) RETURNING id`);
  return u.id;
}
async function member(teamId: string, userId: string, role: 'owner' | 'admin' | 'member') {
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${userId}::uuid, ${role})`);
}
async function sessionAccount(teamId: string) {
  const k = `k-${rand()}`;
  await q(sql`INSERT INTO accounts (type, name, api_key, team_id, auth_type) VALUES ('user', ${k}, ${k}, ${teamId}::uuid, 'oauth')`);
}
async function workspace(teamId: string, name = `ws-${rand()}`): Promise<string> {
  const [w] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id, access_mode) VALUES (${name}, ${teamId}::uuid, 'open') RETURNING id`);
  return w.id;
}
async function client(): Promise<string> {
  return (await storage.createClient({ clientName: 'team access test', redirectUris: ['https://client.example/cb'] })).clientId;
}
async function connect(o: { userId: string; teamIds?: string[]; workspaceIds?: string[] }) {
  const clientId = await client();
  const r = await grants.createGrant({ userId: o.userId, clientId, actsAs: 'agent', scopes: ['read', 'write'], workspaceIds: o.workspaceIds ?? [], teamIds: o.teamIds ?? [] });
  if (!r.ok) throw new Error(`createGrant: ${r.error}`);
  const { token } = await tokens.signGrantAccessToken({ userId: o.userId, grantId: r.grantId, clientId, scope: 'mcp' });
  return { grantId: r.grantId, clientId, jwt: token };
}

let rpcId = 0;
async function listed(jwt: string): Promise<{ status: number; ids: string[]; teamNames: string[] }> {
  const res = await mcpRoute.POST(new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'buildd', arguments: { action: 'list_workspaces', params: { limit: 50 } } } }),
  }));
  if (res.status !== 200) return { status: res.status, ids: [], teamNames: [] };
  const body = await res.json() as { result?: { content: Array<{ text: string }> } };
  const out = JSON.parse(body.result!.content[0].text) as { teams: Array<{ teamName: string; workspaces: Array<{ id: string }> }> };
  return { status: 200, ids: out.teams.flatMap((t) => t.workspaces.map((w) => w.id)).sort(), teamNames: out.teams.map((t) => t.teamName) };
}

const asUser = async <T>(userId: string, fn: () => Promise<T>): Promise<T> => {
  session = { id: userId, email: `${userId}@example.test`, name: null, image: null, timezone: null };
  try { return await fn(); } finally { session = null; }
};
const json = (url: string, method: string, body?: unknown) =>
  new NextRequest(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const patch = (userId: string, grantId: string, body: unknown) => asUser(userId, () =>
  grantRoute.PATCH(json(`http://localhost/api/mcp-grants/${grantId}`, 'PATCH', body), { params: Promise.resolve({ id: grantId }) }));
const rows = async (grantId: string) => ({
  teams: (await q<{ team_id: string }>(sql`SELECT team_id FROM mcp_oauth_grant_teams WHERE grant_id = ${grantId}::uuid`)).map((r) => r.team_id).sort(),
  workspaces: (await q<{ workspace_id: string }>(sql`SELECT workspace_id FROM mcp_oauth_grant_workspaces WHERE grant_id = ${grantId}::uuid`)).map((r) => r.workspace_id).sort(),
});
const sorted = (...ids: string[]) => [...ids].sort();

/** Owner of A (two workspaces and an internal one), member of B, not on C. */
async function world() {
  const userId = await user();
  const a = await seedWorkspace();
  const b = await seedWorkspace();
  const c = await seedWorkspace();
  for (const t of [a, b, c]) await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${t.workspaceId}::uuid`);
  const a2 = await workspace(a.teamId);
  const coord = await workspace(a.teamId, '__coordination');
  await member(a.teamId, userId, 'owner');
  await member(b.teamId, userId, 'member');
  await sessionAccount(a.teamId);
  await sessionAccount(b.teamId);
  return { userId, a, b, c, a2, coord };
}

describe('resolution', () => {
  test('a whole-team grant reaches every non-internal workspace of that team, and nothing of another team the user is on', async () => {
    const w = await world();
    const { grantId, jwt } = await connect({ userId: w.userId, teamIds: [w.a.teamId] });
    expect((await grants.resolveGrantedWorkspaces(grantId, w.userId)).map((x) => x.workspaceId)).toEqual(sorted(w.a.workspaceId, w.a2));
    const l = await listed(jwt);
    expect(l.ids).toEqual(sorted(w.a.workspaceId, w.a2));
    expect(l.ids).not.toContain(w.coord);
    expect(l.ids).not.toContain(w.b.workspaceId);
    expect(l.teamNames.every((n) => n.trim().length > 0)).toBe(true);
  });

  test('a team the user is not on cannot be granted; nothing is written', async () => {
    const w = await world();
    const clientId = await client();
    const before = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM mcp_oauth_grants WHERE user_id = ${w.userId}::uuid`);
    const r = await grants.createGrant({ userId: w.userId, clientId, actsAs: 'agent', scopes: ['read'], workspaceIds: [], teamIds: [w.a.teamId, w.c.teamId] });
    expect(r).toEqual({ ok: false, error: 'workspace_not_accessible' });
    const after = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM mcp_oauth_grants WHERE user_id = ${w.userId}::uuid`);
    expect(after[0].n).toBe(before[0].n);
  });

  test('a new connection records who made it and what it covers', async () => {
    const w = await world();
    const { grantId } = await connect({ userId: w.userId, teamIds: [w.a.teamId], workspaceIds: [w.b.workspaceId] });
    const [ev] = await q<{ actor_user_id: string; action: string; after: Record<string, unknown> }>(sql`
      SELECT actor_user_id, action, after FROM mcp_oauth_grant_events WHERE grant_id = ${grantId}::uuid`);
    expect(ev.actor_user_id).toBe(w.userId);
    expect(ev.action).toBe('connection.created');
    expect(ev.after).toMatchObject({ wholeTeamIds: [w.a.teamId], specificWorkspaceIds: [w.b.workspaceId] });
  });
});

describe('future workspaces on the same access token, cache warm', () => {
  test('a workspace created in the team (POST /api/workspaces) is listed on the next request; a specific-only grant does not get it', async () => {
    const w = await world();
    const whole = await connect({ userId: w.userId, teamIds: [w.a.teamId] });
    const specific = await connect({ userId: w.userId, workspaceIds: [w.a.workspaceId] });
    expect((await listed(whole.jwt)).ids).toEqual(sorted(w.a.workspaceId, w.a2));
    expect((await listed(specific.jwt)).ids).toEqual([w.a.workspaceId]);

    const res = await asUser(w.userId, () => workspacesRoute.POST(json('http://localhost/api/workspaces', 'POST', { name: `new-${rand()}`, teamId: w.a.teamId })));
    expect(res.status).toBeLessThan(300);
    const created = (await res.json() as { id?: string; workspace?: { id: string } });
    const newId = created.id ?? created.workspace!.id;

    expect((await listed(whole.jwt)).ids).toEqual(sorted(w.a.workspaceId, w.a2, newId));
    expect((await listed(specific.jwt)).ids).toEqual([w.a.workspaceId]);
  });

  test('a workspace moved into the team is reached; one moved out, or deleted, is not', async () => {
    const w = await world();
    const { jwt } = await connect({ userId: w.userId, teamIds: [w.a.teamId] });
    expect((await listed(jwt)).ids).toEqual(sorted(w.a.workspaceId, w.a2));

    // A move, with the clears the migration's workspace_team phase makes (lib/workspace-migration.ts).
    const move = async (id: string, from: string, to: string) => {
      await q(sql`UPDATE workspaces SET team_id = ${to}::uuid WHERE id = ${id}::uuid`);
      await clearCallerCache(callerDep.workspace(id), callerDep.teamOpenWorkspaces(from), callerDep.teamOpenWorkspaces(to), callerDep.teamWorkspaces(from), callerDep.teamWorkspaces(to));
    };
    const incoming = await workspace(w.c.teamId);
    await move(incoming, w.c.teamId, w.a.teamId);
    expect((await listed(jwt)).ids).toEqual(sorted(w.a.workspaceId, w.a2, incoming));

    await move(w.a2, w.a.teamId, w.c.teamId);
    expect((await listed(jwt)).ids).toEqual(sorted(w.a.workspaceId, incoming));

    const del = await asUser(w.userId, () => workspaceRoute.DELETE(json(`http://localhost/api/workspaces/${incoming}`, 'DELETE'), { params: Promise.resolve({ id: incoming }) }));
    expect(del.status).toBe(200);
    expect((await listed(jwt)).ids).toEqual([w.a.workspaceId]);
  });
});

describe('access ends on the next request', () => {
  test('membership loss through the members route', async () => {
    const w = await world();
    const ownerId = await user();
    await member(w.b.teamId, ownerId, 'owner');
    const { jwt } = await connect({ userId: w.userId, teamIds: [w.b.teamId] });
    expect((await listed(jwt)).ids).toEqual([w.b.workspaceId]);
    const res = await asUser(ownerId, () => memberRoute.DELETE(
      json(`http://localhost/api/teams/${w.b.teamId}/members/${w.userId}`, 'DELETE'),
      { params: Promise.resolve({ id: w.b.teamId, userId: w.userId }) },
    ));
    expect(res.status).toBe(200);
    expect((await listed(jwt)).status).toBe(401);
  });

  test('revoke and expiry', async () => {
    const w = await world();
    const one = await connect({ userId: w.userId, teamIds: [w.a.teamId] });
    expect((await listed(one.jwt)).status).toBe(200);
    expect(await grants.revokeGrant(one.grantId, w.userId)).toBe(true);
    expect((await listed(one.jwt)).status).toBe(401);

    const two = await connect({ userId: w.userId, teamIds: [w.a.teamId] });
    await q(sql`UPDATE mcp_oauth_grants SET expires_at = now() - interval '1 minute' WHERE id = ${two.grantId}::uuid`);
    expect(await grants.resolveGrantedWorkspaces(two.grantId, w.userId)).toEqual([]);
    expect(await grants.resolveGrant(two.grantId, w.userId, two.clientId)).toBeNull();
  });
});

describe('Settings', () => {
  test('an existing specific grant keeps exactly its set until the owner turns on all workspaces, which applies on the same token', async () => {
    const w = await world();
    const { grantId, jwt } = await connect({ userId: w.userId, workspaceIds: [w.a.workspaceId, w.b.workspaceId] });
    const later = await workspace(w.a.teamId);
    await clearCallerCache(callerDep.teamWorkspaces(w.a.teamId));
    expect((await listed(jwt)).ids).toEqual(sorted(w.a.workspaceId, w.b.workspaceId));

    const res = await patch(w.userId, grantId, { teams: [{ teamId: w.a.teamId, mode: 'all' }], ifRevision: 0 });
    expect(res.status).toBe(200);
    const { connection } = await res.json() as { connection: { revision: number; teams: Array<{ teamId: string; mode: string }> } };
    expect(connection.revision).toBe(1);
    expect(connection.teams.find((t) => t.teamId === w.a.teamId)!.mode).toBe('all');
    expect((await listed(jwt)).ids).toEqual(sorted(w.a.workspaceId, w.a2, later, w.b.workspaceId));

    const [ev] = await q<{ actor_user_id: string; before: Record<string, unknown>; after: Record<string, unknown> }>(sql`
      SELECT actor_user_id, before, after FROM mcp_oauth_grant_events WHERE grant_id = ${grantId}::uuid AND action = 'connection.updated'`);
    expect(ev.actor_user_id).toBe(w.userId);
    expect(ev.before).toMatchObject({ wholeTeamIds: [] });
    expect(ev.after).toMatchObject({ wholeTeamIds: [w.a.teamId] });
  });

  test('switching to specific freezes exactly the reviewed selection; a later workspace is not added', async () => {
    const w = await world();
    const { grantId, jwt } = await connect({ userId: w.userId, teamIds: [w.a.teamId] });
    const res = await patch(w.userId, grantId, { teams: [{ teamId: w.a.teamId, mode: 'specific', workspaceIds: [w.a2] }], ifRevision: 0 });
    expect(res.status).toBe(200);
    expect(await rows(grantId)).toEqual({ teams: [], workspaces: [w.a2] });
    expect((await listed(jwt)).ids).toEqual([w.a2]);
    await workspace(w.a.teamId);
    await clearCallerCache(callerDep.teamWorkspaces(w.a.teamId));
    expect((await listed(jwt)).ids).toEqual([w.a2]);
  });

  test('removing a workspace a whole-team choice still covers is refused, and nothing changes', async () => {
    const w = await world();
    const { grantId } = await connect({ userId: w.userId, teamIds: [w.a.teamId] });
    const res = await patch(w.userId, grantId, { removeWorkspaceIds: [w.a2] });
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('inherited_from_team');
    expect(await rows(grantId)).toEqual({ teams: [w.a.teamId], workspaces: [] });
  });

  test('a stale revision is refused with the current state and writes nothing', async () => {
    const w = await world();
    const { grantId } = await connect({ userId: w.userId, workspaceIds: [w.a.workspaceId] });
    expect((await patch(w.userId, grantId, { access: 'read', ifRevision: 0 })).status).toBe(200);
    const res = await patch(w.userId, grantId, { teams: [{ teamId: w.a.teamId, mode: 'all' }], ifRevision: 0 });
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string; connection: { revision: number; access: string } };
    expect(body.code).toBe('stale_connection');
    expect(body.connection).toMatchObject({ revision: 1, access: 'read' });
    expect(await rows(grantId)).toEqual({ teams: [], workspaces: [w.a.workspaceId] });
  });

  test('a forged team, a workspace of another team named under it, or another user\'s grant changes nothing', async () => {
    const w = await world();
    const other = await user();
    const { grantId } = await connect({ userId: w.userId, workspaceIds: [w.a.workspaceId] });

    const forged = await patch(w.userId, grantId, { teams: [{ teamId: w.c.teamId, mode: 'all' }] });
    expect(forged.status).toBe(403);
    expect(await forged.text()).not.toContain(w.c.teamId);

    const crossed = await patch(w.userId, grantId, { teams: [{ teamId: w.a.teamId, mode: 'specific', workspaceIds: [w.b.workspaceId] }] });
    expect(crossed.status).toBe(403);

    const notMine = await patch(other, grantId, { teams: [{ teamId: w.a.teamId, mode: 'all' }] });
    expect(notMine.status).toBe(404);

    expect(await rows(grantId)).toEqual({ teams: [], workspaces: [w.a.workspaceId] });
  });

  test('turning on all workspaces for a team joined after connecting provisions its session account', async () => {
    const w = await world();
    const d = await seedWorkspace();
    await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${d.workspaceId}::uuid`);
    const { grantId, jwt } = await connect({ userId: w.userId, workspaceIds: [w.a.workspaceId] });
    await member(d.teamId, w.userId, 'member');
    expect((await patch(w.userId, grantId, { teams: [{ teamId: d.teamId, mode: 'all' }] })).status).toBe(200);
    const accts = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM accounts WHERE team_id = ${d.teamId}::uuid AND type = 'user'`);
    expect(accts[0].n).toBe(1);
    expect((await listed(jwt)).ids).toEqual(sorted(w.a.workspaceId, d.workspaceId));
  });

  test('GET lists each team with its mode and the workspaces it reaches now', async () => {
    const w = await world();
    await connect({ userId: w.userId, teamIds: [w.a.teamId], workspaceIds: [w.b.workspaceId] });
    const res = await asUser(w.userId, () => listRoute.GET());
    const body = await res.json() as { connections: Array<{ teams: Array<{ teamId: string; mode: string; workspaces: Array<{ id: string }> }> }> };
    const teams = body.connections[0].teams;
    expect(teams.find((t) => t.teamId === w.a.teamId)).toMatchObject({ mode: 'all' });
    expect(teams.find((t) => t.teamId === w.a.teamId)!.workspaces.map((x) => x.id).sort()).toEqual(sorted(w.a.workspaceId, w.a2));
    expect(teams.find((t) => t.teamId === w.b.teamId)).toMatchObject({ mode: 'specific' });
  });
});

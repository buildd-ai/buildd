/**
 * Managing your own MCP connections from Settings, against real Postgres
 * (docs/specs/auth-oauth-boundaries.md, "Managing connections").
 *
 * Through the real /api/mcp-grants handlers with a signed-in person:
 *  - a person lists and edits only their own grants; another user's grant id
 *    answers 404 and is left untouched, refresh tokens included;
 *  - adding a workspace is re-validated against current membership, and one
 *    unreachable id refuses the whole change without naming it;
 *  - shrink, read-only and the person-to-agent downgrade apply on the very
 *    next request on the grant's token (grant sessions are never cached);
 *  - agent-to-person is refused and the row stays an agent grant;
 *  - revoke invalidates every refresh token under the grant, in every
 *    family, and the access token stops resolving;
 *  - legacy per-workspace connections are listed so the page can say so.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

let currentUser: string | null = null;
const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({
  ...realAuthHelpers,
  getCurrentUser: async () => (currentUser ? { id: currentUser, email: 'x@example.test', name: null, image: null, timezone: null } : null),
}));

process.env.AUTH_SECRET ||= 'mcp-grant-management-test-secret-0123456789abcdef';
const grants = await import('../../src/lib/mcp-grants');
const tokens = await import('../../src/lib/oauth/tokens');
const storage = await import('../../src/lib/oauth/storage');
const { authenticateGrantSession, clearAccountCache } = await import('../../src/lib/api-auth');
const { requestingPerson } = await import('../../src/lib/request-person');
const listRoute = await import('../../src/app/api/mcp-grants/route');
const grantRoute = await import('../../src/app/api/mcp-grants/[id]/route');
const tokenRoute = await import('../../src/app/api/oauth/token/route');

beforeAll(() => assertDbConfigured());
afterEach(() => { currentUser = null; clearAccountCache(); });

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

async function user(): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  return u.id;
}
async function member(teamId: string, userId: string, role = 'member') {
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${userId}::uuid, ${role})`);
}
async function teamAccount(teamId: string) {
  const key = `k-${rand()}`;
  await q(sql`INSERT INTO accounts (type, name, api_key, team_id, auth_type) VALUES ('user', ${key}, ${key}, ${teamId}::uuid, 'oauth')`);
}
async function grant(o: { userId: string; clientId: string; actsAs: 'person' | 'agent'; workspaceIds: string[]; scopes?: Array<'read' | 'write'> }) {
  const r = await grants.createGrant({ ...o, scopes: o.scopes ?? ['read', 'write'] });
  if (!r.ok) throw new Error(`createGrant: ${r.error}`);
  return r.grantId;
}
async function jwtFor(userId: string, grantId: string, clientId: string) {
  return (await tokens.signGrantAccessToken({ userId, grantId, clientId, scope: 'mcp' })).token;
}

/** Two teams the user is in, a third workspace in team A, and a team they are not in. */
async function setup() {
  const userId = await user();
  const a = await seedWorkspace();
  const b = await seedWorkspace();
  const outside = await seedWorkspace();
  const [a2] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id) VALUES (${`w-${rand()}`}, ${a.teamId}::uuid) RETURNING id`);
  await member(a.teamId, userId, 'owner');
  await member(b.teamId, userId, 'member');
  await teamAccount(a.teamId);
  await teamAccount(b.teamId);
  const { clientId } = await storage.createClient({ clientName: 'Laptop app', redirectUris: ['https://client.example/cb'] });
  currentUser = userId;
  return { userId, a, b, a2: a2.id, outside, clientId };
}

function list() {
  return listRoute.GET();
}
function patch(id: string, body: unknown) {
  return grantRoute.PATCH(
    new NextRequest(`http://localhost/api/mcp-grants/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    { params: Promise.resolve({ id }) },
  );
}
function revoke(id: string) {
  return grantRoute.DELETE(new NextRequest(`http://localhost/api/mcp-grants/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });
}
function refresh(refreshToken: string, clientId: string) {
  return tokenRoute.POST(new NextRequest('http://localhost/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
  }));
}
async function grantRow(id: string) {
  const [g] = await q<{ acts_as: string; scopes: string[]; revoked_at: string | null }>(sql`SELECT acts_as, scopes, revoked_at FROM mcp_oauth_grants WHERE id = ${id}::uuid`);
  return g;
}
async function grantWorkspaceIds(id: string) {
  return (await q<{ workspace_id: string }>(sql`SELECT workspace_id FROM mcp_oauth_grant_workspaces WHERE grant_id = ${id}::uuid ORDER BY workspace_id`)).map((r) => r.workspace_id);
}

describe('who may manage a grant', () => {
  test('no session: 401 on every verb', async () => {
    const { userId, a, clientId } = await setup();
    const g = await grant({ userId, clientId, actsAs: 'agent', workspaceIds: [a.workspaceId] });
    currentUser = null;
    expect((await list()).status).toBe(401);
    expect((await patch(g, { access: 'read' })).status).toBe(401);
    expect((await revoke(g)).status).toBe(401);
    expect((await grantRow(g)).revoked_at).toBeNull();
  });

  test('lists only the signed-in person\'s own active grants, with names and teams', async () => {
    const s = await setup();
    const mine = await grant({ userId: s.userId, clientId: s.clientId, actsAs: 'person', workspaceIds: [s.a.workspaceId, s.b.workspaceId] });
    const gone = await grant({ userId: s.userId, clientId: s.clientId, actsAs: 'agent', workspaceIds: [s.a.workspaceId] });
    await grants.revokeGrant(gone, s.userId);
    const other = await user();
    await member(s.a.teamId, other);
    const theirs = await grant({ userId: other, clientId: s.clientId, actsAs: 'person', workspaceIds: [s.a.workspaceId] });

    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connections.map((c: { id: string }) => c.id)).toEqual([mine]);
    expect(JSON.stringify(body)).not.toContain(theirs);
    const [c] = body.connections;
    expect(c).toMatchObject({ clientName: 'Laptop app', actsAs: 'person', access: 'read-write', unreachableCount: 0 });
    expect(c.workspaces.map((w: { id: string }) => w.id).sort()).toEqual([s.a.workspaceId, s.b.workspaceId].sort());
    // The picker gets the person's own teams, never the outside one.
    const teamIds = body.teams.map((t: { id: string }) => t.id);
    expect(teamIds.sort()).toEqual([s.a.teamId, s.b.teamId].sort());
    expect(JSON.stringify(body.teams)).not.toContain(s.outside.workspaceId);
  });

  test('a workspace the person has left is counted, not listed', async () => {
    const s = await setup();
    const g = await grant({ userId: s.userId, clientId: s.clientId, actsAs: 'agent', workspaceIds: [s.a.workspaceId, s.b.workspaceId] });
    await q(sql`DELETE FROM team_members WHERE team_id = ${s.b.teamId}::uuid AND user_id = ${s.userId}::uuid`);
    const [c] = (await (await list()).json()).connections;
    expect(c.id).toBe(g);
    expect(c.workspaces.map((w: { id: string }) => w.id)).toEqual([s.a.workspaceId]);
    expect(c.unreachableCount).toBe(1);
  });

  test('another user\'s grant: PATCH and DELETE answer 404 and change nothing, refresh tokens included', async () => {
    const s = await setup();
    const other = await user();
    await member(s.a.teamId, other, 'owner');
    const theirs = await grant({ userId: other, clientId: s.clientId, actsAs: 'person', workspaceIds: [s.a.workspaceId] });
    const rt = await storage.createRefreshToken({ clientId: s.clientId, userId: other, grantId: theirs, scope: 'mcp' });

    for (const res of [await patch(theirs, { access: 'read' }), await patch(theirs, { addWorkspaceIds: [s.a2] }), await patch(theirs, { actsAs: 'agent' }), await revoke(theirs)]) {
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain(theirs);
    }
    expect(await grantRow(theirs)).toMatchObject({ acts_as: 'person', scopes: ['read', 'write'], revoked_at: null });
    expect(await grantWorkspaceIds(theirs)).toEqual([s.a.workspaceId]);
    const live = await q(sql`SELECT 1 FROM oauth_refresh_tokens WHERE grant_id = ${theirs}::uuid AND revoked_at IS NULL`);
    expect(live.length).toBe(1);
    expect((await refresh(rt, s.clientId)).status).toBe(200);
  });

  test('an id that does not exist and one that is not an id read the same', async () => {
    await setup();
    for (const id of [crypto.randomUUID(), 'not-a-grant']) {
      expect((await patch(id, { access: 'read' })).status).toBe(404);
      expect((await revoke(id)).status).toBe(404);
    }
  });
});

describe('expand', () => {
  test('adds a reachable workspace, and the next request on the same token reaches it', async () => {
    const s = await setup();
    const g = await grant({ userId: s.userId, clientId: s.clientId, actsAs: 'agent', workspaceIds: [s.a.workspaceId] });
    const jwt = await jwtFor(s.userId, g, s.clientId);
    expect(await authenticateGrantSession(jwt, s.b.workspaceId)).toBeNull();

    const res = await patch(g, { addWorkspaceIds: [s.b.workspaceId, s.a2] });
    expect(res.status).toBe(200);
    const { connection } = await res.json();
    expect(connection.workspaces.map((w: { id: string }) => w.id).sort()).toEqual([s.a.workspaceId, s.b.workspaceId, s.a2].sort());
    expect(await authenticateGrantSession(jwt, s.b.workspaceId)).toMatchObject({ teamId: s.b.teamId, workspaceIds: [s.b.workspaceId] });
  });

  test('one unreachable workspace refuses the whole change, writes nothing and names no id', async () => {
    const s = await setup();
    const g = await grant({ userId: s.userId, clientId: s.clientId, actsAs: 'agent', workspaceIds: [s.a.workspaceId], scopes: ['read'] });
    const missing = crypto.randomUUID();
    for (const bad of [[s.b.workspaceId, s.outside.workspaceId], [missing], ['not-a-uuid']]) {
      const res = await patch(g, { addWorkspaceIds: bad, access: 'read-write' });
      expect(res.status).toBe(403);
      const text = JSON.stringify(await res.json());
      for (const id of bad) expect(text).not.toContain(id);
      expect(text).toContain('workspace_not_accessible');
    }
    expect(await grantWorkspaceIds(g)).toEqual([s.a.workspaceId]);
    expect((await grantRow(g)).scopes).toEqual(['read']);
  });

  test('membership is re-checked at the edit, not taken from the page that offered it', async () => {
    const s = await setup();
    const g = await grant({ userId: s.userId, clientId: s.clientId, actsAs: 'agent', workspaceIds: [s.a.workspaceId] });
    const offered = (await (await list()).json()).teams.flatMap((t: { workspaces: { id: string }[] }) => t.workspaces.map((w) => w.id));
    expect(offered).toContain(s.b.workspaceId);
    await q(sql`DELETE FROM team_members WHERE team_id = ${s.b.teamId}::uuid AND user_id = ${s.userId}::uuid`);
    expect((await patch(g, { addWorkspaceIds: [s.b.workspaceId] })).status).toBe(403);
    expect(await grantWorkspaceIds(g)).toEqual([s.a.workspaceId]);
  });
});

describe('shrink and read/write', () => {
  test('removing a workspace applies on the next request', async () => {
    const s = await setup();
    const g = await grant({ userId: s.userId, clientId: s.clientId, actsAs: 'agent', workspaceIds: [s.a.workspaceId, s.b.workspaceId] });
    const jwt = await jwtFor(s.userId, g, s.clientId);
    expect(await authenticateGrantSession(jwt, s.b.workspaceId)).not.toBeNull();
    expect((await patch(g, { removeWorkspaceIds: [s.b.workspaceId] })).status).toBe(200);
    expect(await authenticateGrantSession(jwt, s.b.workspaceId)).toBeNull();
    expect(await authenticateGrantSession(jwt, s.a.workspaceId)).not.toBeNull();
  });

  test('removing the last reachable workspace is refused: revoke instead', async () => {
    const s = await setup();
    const g = await grant({ userId: s.userId, clientId: s.clientId, actsAs: 'agent', workspaceIds: [s.a.workspaceId] });
    const res = await patch(g, { removeWorkspaceIds: [s.a.workspaceId] });
    expect(res.status).toBe(400);
    expect(await grantWorkspaceIds(g)).toEqual([s.a.workspaceId]);
  });

  test('read-only applies on the next request, and write can be turned back on', async () => {
    const s = await setup();
    const g = await grant({ userId: s.userId, clientId: s.clientId, actsAs: 'agent', workspaceIds: [s.a.workspaceId] });
    const jwt = await jwtFor(s.userId, g, s.clientId);
    expect((await authenticateGrantSession(jwt, s.a.workspaceId))?.scopes).toBeNull();
    expect((await patch(g, { access: 'read' })).status).toBe(200);
    expect((await authenticateGrantSession(jwt, s.a.workspaceId))?.scopes).toEqual([...grants.READ_GRANT_TOKEN_SCOPES]);
    expect((await patch(g, { access: 'read-write' })).status).toBe(200);
    expect((await authenticateGrantSession(jwt, s.a.workspaceId))?.scopes).toBeNull();
  });
});

describe('acts as you / agent working for you', () => {
  test('a person grant can be downgraded to agent; the next request is no longer a person', async () => {
    const s = await setup();
    const g = await grant({ userId: s.userId, clientId: s.clientId, actsAs: 'person', workspaceIds: [s.a.workspaceId] });
    const rt = await storage.createRefreshToken({ clientId: s.clientId, userId: s.userId, grantId: g, scope: 'buildd:read buildd:write buildd:act-as-person' });
    const jwt = await jwtFor(s.userId, g, s.clientId);
    const before = await authenticateGrantSession(jwt, s.a.workspaceId);
    expect(requestingPerson(null, before)).toBe(s.userId);

    const res = await patch(g, { actsAs: 'agent' });
    expect(res.status).toBe(200);
    expect((await res.json()).connection.actsAs).toBe('agent');
    expect((await grantRow(g)).acts_as).toBe('agent');
    const after = await authenticateGrantSession(jwt, s.a.workspaceId);
    expect(after).not.toBeNull();
    expect(requestingPerson(null, after)).toBeNull();

    // The next token response no longer claims the person scope.
    const r = await refresh(rt, s.clientId);
    expect(r.status).toBe(200);
    expect(String((await r.json()).scope)).not.toContain('act-as-person');
  });

  test('agent to person is refused through the API and the row stays an agent grant', async () => {
    const s = await setup();
    const g = await grant({ userId: s.userId, clientId: s.clientId, actsAs: 'agent', workspaceIds: [s.a.workspaceId] });
    const res = await patch(g, { actsAs: 'person' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('person_needs_consent');
    // Bundled with an otherwise valid change, nothing at all is applied.
    expect((await patch(g, { actsAs: 'person', access: 'read', addWorkspaceIds: [s.b.workspaceId] })).status).toBe(403);
    expect(await grantRow(g)).toMatchObject({ acts_as: 'agent', scopes: ['read', 'write'] });
    expect(await grantWorkspaceIds(g)).toEqual([s.a.workspaceId]);
    const jwt = await jwtFor(s.userId, g, s.clientId);
    expect(requestingPerson(null, await authenticateGrantSession(jwt, s.a.workspaceId))).toBeNull();
  });
});

describe('revoke', () => {
  test('revokes the grant and every refresh token in every family; the token stops at once', async () => {
    const s = await setup();
    const g = await grant({ userId: s.userId, clientId: s.clientId, actsAs: 'person', workspaceIds: [s.a.workspaceId] });
    // Two sign-ins on the same grant: two families.
    const rt1 = await storage.createRefreshToken({ clientId: s.clientId, userId: s.userId, grantId: g, scope: 'mcp' });
    const rt2 = await storage.createRefreshToken({ clientId: s.clientId, userId: s.userId, grantId: g, scope: 'mcp' });
    const fams = await q<{ n: number }>(sql`SELECT count(DISTINCT family_id)::int AS n FROM oauth_refresh_tokens WHERE grant_id = ${g}::uuid`);
    expect(fams[0].n).toBe(2);
    const jwt = await jwtFor(s.userId, g, s.clientId);
    expect(await authenticateGrantSession(jwt, s.a.workspaceId)).not.toBeNull();

    const res = await revoke(g);
    expect(res.status).toBe(200);
    expect((await grantRow(g)).revoked_at).not.toBeNull();
    const live = await q(sql`SELECT 1 FROM oauth_refresh_tokens WHERE grant_id = ${g}::uuid AND revoked_at IS NULL`);
    expect(live.length).toBe(0);
    expect(await authenticateGrantSession(jwt, s.a.workspaceId)).toBeNull();
    for (const rt of [rt1, rt2]) expect((await refresh(rt, s.clientId)).status).toBe(400);
    // Gone from the list, and a second revoke is a 404.
    expect((await (await list()).json()).connections).toEqual([]);
    expect((await revoke(g)).status).toBe(404);
    expect((await patch(g, { access: 'read' })).status).toBe(404);
  });

  test('revokeGrant with another user\'s grant id leaves their refresh tokens alone', async () => {
    const s = await setup();
    const other = await user();
    await member(s.a.teamId, other);
    const theirs = await grant({ userId: other, clientId: s.clientId, actsAs: 'agent', workspaceIds: [s.a.workspaceId] });
    await storage.createRefreshToken({ clientId: s.clientId, userId: other, grantId: theirs, scope: 'mcp' });
    expect(await grants.revokeGrant(theirs, s.userId)).toBe(false);
    const live = await q(sql`SELECT 1 FROM oauth_refresh_tokens WHERE grant_id = ${theirs}::uuid AND revoked_at IS NULL`);
    expect(live.length).toBe(1);
  });
});

describe('legacy per-workspace connections', () => {
  test('are listed by app and workspace so the page can suggest one connection', async () => {
    const s = await setup();
    await storage.createRefreshToken({ clientId: s.clientId, userId: s.userId, workspaceId: s.a.workspaceId, scope: 'mcp' });
    await storage.createRefreshToken({ clientId: s.clientId, userId: s.userId, workspaceId: s.a.workspaceId, scope: 'mcp' });
    // Outside the person's teams now: not listed.
    await storage.createRefreshToken({ clientId: s.clientId, userId: s.userId, workspaceId: s.outside.workspaceId, scope: 'mcp' });
    const { legacy } = await (await list()).json();
    expect(legacy.length).toBe(1);
    expect(legacy[0]).toMatchObject({ clientName: 'Laptop app' });
    expect(typeof legacy[0].workspaceName).toBe('string');
    expect(JSON.stringify(legacy)).not.toContain(s.outside.workspaceId);
  });
});

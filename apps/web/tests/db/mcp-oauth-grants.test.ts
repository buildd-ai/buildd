/**
 * Account-level MCP OAuth grants against real Postgres
 * (docs/specs/auth-oauth-boundaries.md, "Account-level MCP grants").
 *
 * A grant token names a grant and nothing else; what it reaches is the
 * grant's workspaces ∩ the user's current team memberships, resolved in SQL on
 * every request and at every refresh. A mocked `db` cannot see those
 * predicates, so every scoping invariant here runs on real rows: membership
 * loss, a revoked or expired grant, another user's grant, a deleted or moved
 * workspace, a legacy workspace-claim token, refresh revalidation, and that
 * no refusal names an ungranted id.
 *
 * The acts-as kind: a 'person' grant is the user (a `human:` principal), an
 * 'agent' grant is the user's agent and is refused by every person-only
 * action (here: Abandon and a forced review), through lib/request-person.ts.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedWorkspace } from './harness';
import { world, type World } from './workflow-scenarios-world';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

process.env.AUTH_SECRET ||= 'mcp-oauth-grants-test-secret-0123456789abcdef';
const grants = await import('../../src/lib/mcp-grants');
const tokens = await import('../../src/lib/oauth/tokens');
const storage = await import('../../src/lib/oauth/storage');
const { authenticateApiKey, clearAccountCache } = await import('../../src/lib/api-auth');
const { requestingPerson } = await import('../../src/lib/request-person');
const tokenRoute = await import('../../src/app/api/oauth/token/route');
const closedPrsRoute = await import('../../src/app/api/missions/[id]/closed-prs/route');
const reviewRoute = await import('../../src/app/api/github/pr/review/route');

beforeAll(() => assertDbConfigured());

let w: World | undefined;
afterEach(() => { w?.dispose(); w = undefined; clearAccountCache(); });

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
async function grant(o: { userId: string; clientId: string; actsAs: 'person' | 'agent'; workspaceIds: string[]; scopes?: Array<'read' | 'write'> }) {
  const r = await grants.createGrant({ ...o, scopes: o.scopes ?? ['read', 'write'] });
  if (!r.ok) throw new Error(`createGrant: ${r.error}`);
  return r.grantId;
}
async function grantToken(userId: string, grantId: string, clientId: string) {
  return (await tokens.signGrantAccessToken({ userId, grantId, clientId, scope: 'mcp' })).token;
}

/** Two teams the user is in, one workspace each, plus a team they are not in. */
async function setup() {
  const userId = await user();
  const a = await seedWorkspace();
  const b = await seedWorkspace();
  const outside = await seedWorkspace();
  await member(a.teamId, userId, 'owner');
  await member(b.teamId, userId, 'member');
  await teamAccount(a.teamId);
  await teamAccount(b.teamId);
  const clientId = await client();
  return { userId, a, b, outside, clientId };
}

function tokenPost(body: Record<string, string>) {
  return tokenRoute.POST(new NextRequest('http://localhost/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  }));
}

describe('creating a grant', () => {
  test('refuses a workspace the user cannot reach, writes nothing, and names no id', async () => {
    const { userId, a, outside, clientId } = await setup();
    const r = await grants.createGrant({ userId, clientId, actsAs: 'person', scopes: ['read'], workspaceIds: [a.workspaceId, outside.workspaceId] });
    expect(r).toEqual({ ok: false, error: 'workspace_not_accessible' });
    expect(JSON.stringify(r)).not.toContain(outside.workspaceId);
    const rows = await q(sql`SELECT 1 FROM mcp_oauth_grants WHERE user_id = ${userId}::uuid`);
    expect(rows.length).toBe(0);
  });

  test('the table refuses an unknown kind or scope', async () => {
    const { userId, clientId } = await setup();
    await expect(q(sql`INSERT INTO mcp_oauth_grants (user_id, client_id, acts_as, scopes) VALUES (${userId}::uuid, ${clientId}, 'owner', '["read"]'::jsonb)`)).rejects.toThrow();
    await expect(q(sql`INSERT INTO mcp_oauth_grants (user_id, client_id, acts_as, scopes) VALUES (${userId}::uuid, ${clientId}, 'agent', '["admin"]'::jsonb)`)).rejects.toThrow();
    await expect(q(sql`INSERT INTO mcp_oauth_grants (user_id, client_id, acts_as, scopes) VALUES (${userId}::uuid, ${clientId}, 'agent', '[]'::jsonb)`)).rejects.toThrow();
  });
});

describe('resolveGrantedWorkspaces: the grant ∩ current membership', () => {
  test('returns exactly the granted workspaces across teams, never an ungranted one', async () => {
    const { userId, a, b, clientId } = await setup();
    const extra = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id) VALUES (${`w-${rand()}`}, ${a.teamId}::uuid) RETURNING id`);
    const grantId = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId, b.workspaceId] });
    const got = (await grants.resolveGrantedWorkspaces(grantId, userId)).map((x) => x.workspaceId).sort();
    expect(got).toEqual([a.workspaceId, b.workspaceId].sort());
    expect(got).not.toContain(extra[0].id); // a new workspace in a granted team is not auto-granted
  });

  test('membership loss drops that team\'s workspaces immediately', async () => {
    const { userId, a, b, clientId } = await setup();
    const grantId = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId, b.workspaceId] });
    await q(sql`DELETE FROM team_members WHERE team_id = ${b.teamId}::uuid AND user_id = ${userId}::uuid`);
    expect((await grants.resolveGrantedWorkspaces(grantId, userId)).map((x) => x.workspaceId)).toEqual([a.workspaceId]);
  });

  test('a workspace moved to a team the user is not in, or deleted, drops out', async () => {
    const { userId, a, b, outside, clientId } = await setup();
    const grantId = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId, b.workspaceId] });
    await q(sql`UPDATE workspaces SET team_id = ${outside.teamId}::uuid WHERE id = ${b.workspaceId}::uuid`);
    expect((await grants.resolveGrantedWorkspaces(grantId, userId)).map((x) => x.workspaceId)).toEqual([a.workspaceId]);
    await q(sql`DELETE FROM workspaces WHERE id = ${a.workspaceId}::uuid`);
    expect(await grants.resolveGrantedWorkspaces(grantId, userId)).toEqual([]);
  });

  test('a revoked or expired grant, or another user\'s grant id, reaches nothing', async () => {
    const { userId, a, clientId } = await setup();
    const other = await user();
    await member(a.teamId, other);
    const g1 = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId] });
    expect(await grants.resolveGrantedWorkspaces(g1, other)).toEqual([]);
    expect(await grants.resolveGrant(g1, other, clientId)).toBeNull();
    // A different client cannot use the grant either.
    expect(await grants.resolveGrant(g1, userId, 'c_other')).toBeNull();

    expect(await grants.revokeGrant(g1, userId)).toBe(true);
    expect(await grants.resolveGrantedWorkspaces(g1, userId)).toEqual([]);

    const g2 = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId] });
    await q(sql`UPDATE mcp_oauth_grants SET expires_at = now() - interval '1 minute' WHERE id = ${g2}::uuid`);
    expect(await grants.resolveGrantedWorkspaces(g2, userId)).toEqual([]);
  });
});

describe('per-request resolution in authenticateApiKey', () => {
  test('a grant token is confined to its granted workspaces and acts at the team role', async () => {
    const { userId, a, clientId } = await setup();
    const grantId = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId] });
    const acct = await authenticateApiKey(await grantToken(userId, grantId, clientId)) as Record<string, unknown> | null;
    expect(acct).not.toBeNull();
    expect(acct!.teamId).toBe(a.teamId);
    expect(acct!.workspaceIds).toEqual([a.workspaceId]);
    expect(acct!.level).toBe('admin');
    expect(acct!.actsAs).toBe('person');
    expect(acct!.sessionUserId).toBe(userId);
    expect(requestingPerson(null, acct)).toBe(userId);
  });

  test('revoking the grant cuts the very next request off, with no cache window', async () => {
    const { userId, a, clientId } = await setup();
    const grantId = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId] });
    const jwt = await grantToken(userId, grantId, clientId);
    expect(await authenticateApiKey(jwt)).not.toBeNull();
    await grants.revokeGrant(grantId, userId);
    expect(await authenticateApiKey(jwt)).toBeNull();
  });

  test('membership loss cuts the very next request off', async () => {
    const { userId, a, clientId } = await setup();
    const grantId = await grant({ userId, clientId, actsAs: 'agent', workspaceIds: [a.workspaceId] });
    const jwt = await grantToken(userId, grantId, clientId);
    expect(await authenticateApiKey(jwt)).not.toBeNull();
    await q(sql`DELETE FROM team_members WHERE team_id = ${a.teamId}::uuid AND user_id = ${userId}::uuid`);
    expect(await authenticateApiKey(jwt)).toBeNull();
  });

  test('a grant spanning two teams does not pick a team on this path', async () => {
    const { userId, a, b, clientId } = await setup();
    const grantId = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId, b.workspaceId] });
    expect(await authenticateApiKey(await grantToken(userId, grantId, clientId))).toBeNull();
    // Once only one team remains reachable, it acts in that team.
    await q(sql`DELETE FROM team_members WHERE team_id = ${b.teamId}::uuid AND user_id = ${userId}::uuid`);
    const acct = await authenticateApiKey(await grantToken(userId, grantId, clientId)) as Record<string, unknown> | null;
    expect(acct?.teamId).toBe(a.teamId);
  });

  test('a self-call naming an ungranted workspace in the same team is refused', async () => {
    const { userId, a, clientId } = await setup();
    const [sib] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id) VALUES (${`w-${rand()}`}, ${a.teamId}::uuid) RETURNING id`);
    const grantId = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId] });
    const jwt = await grantToken(userId, grantId, clientId);
    const req = (workspaceId: string) => new Request('http://localhost/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId, title: 't' }),
    });
    expect(await authenticateApiKey(jwt, req(a.workspaceId))).not.toBeNull();
    expect(await authenticateApiKey(jwt, req(sib.id))).toBeNull();
  });

  test('a legacy workspace-claim token still works, as the person, with its historical reach', async () => {
    const { userId, a, clientId } = await setup();
    const { token } = await tokens.signAccessToken({ userId, workspaceId: a.workspaceId, clientId, scope: 'mcp' });
    const acct = await authenticateApiKey(token) as Record<string, unknown> | null;
    expect(acct?.teamId).toBe(a.teamId);
    expect(acct?.workspaceIds).toBeNull();
    expect(acct?.actsAs).toBe('person');
    expect(acct?.sessionUserId).toBe(userId);
    expect(requestingPerson(null, acct)).toBe(userId);
    // And it is still bound to its own workspace endpoint, while a grant token is not.
    expect(await tokens.verifyAccessToken(token, a.workspaceId)).not.toBeNull();
    const grantId = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId] });
    expect(await tokens.verifyAccessToken(await grantToken(userId, grantId, clientId), a.workspaceId)).toBeNull();
  });

  test('an agent grant is attributed to the user but has no person principal', async () => {
    const { userId, a, clientId } = await setup();
    const grantId = await grant({ userId, clientId, actsAs: 'agent', workspaceIds: [a.workspaceId] });
    const acct = await authenticateApiKey(await grantToken(userId, grantId, clientId)) as Record<string, unknown> | null;
    expect(acct).not.toBeNull();
    expect(acct!.actsAs).toBe('agent');
    expect(acct!.oauthUserId).toBe(userId);
    expect(acct!.sessionUserId).toBeUndefined();
    expect(requestingPerson(null, acct)).toBeNull();
    expect(grants.grantPrincipal({ actsAs: 'agent', userId }).actor).toBe(`agent:oauth:${userId}`);
  });
});

describe('the token endpoint on a grant', () => {
  async function codeFor(userId: string, grantId: string, clientId: string) {
    const verifier = `v-${rand()}-${rand()}-${rand()}-${rand()}`;
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const code = await storage.createAuthCode({
      grantId, clientId, userId, redirectUri: 'https://client.example/cb',
      codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'mcp',
    });
    return { code, verifier };
  }
  async function exchange(userId: string, grantId: string, clientId: string) {
    const { code, verifier } = await codeFor(userId, grantId, clientId);
    const res = await tokenPost({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: 'https://client.example/cb', code_verifier: verifier });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ access_token: string; refresh_token: string }>;
  }

  test('code and refresh both mint a grant token; refresh keeps the grant and its kind', async () => {
    const { userId, a, clientId } = await setup();
    const grantId = await grant({ userId, clientId, actsAs: 'agent', workspaceIds: [a.workspaceId] });
    const first = await exchange(userId, grantId, clientId);
    const c1 = await tokens.verifyAccessTokenAnyAudience(first.access_token);
    expect(c1 && tokens.isGrantClaims(c1) && c1.grant_id).toBe(grantId);
    expect(JSON.stringify(c1)).not.toContain(a.workspaceId);

    // A client cannot ask for a different kind at refresh; the kind is on the grant row.
    const res = await tokenPost({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId, acts_as: 'person' });
    expect(res.status).toBe(200);
    const second = await res.json() as { access_token: string; refresh_token: string };
    const c2 = await tokens.verifyAccessTokenAnyAudience(second.access_token);
    expect(c2 && tokens.isGrantClaims(c2) && c2.grant_id).toBe(grantId);
    const [rt] = await q<{ grant_id: string; workspace_id: string | null }>(sql`SELECT grant_id, workspace_id FROM oauth_refresh_tokens WHERE token = ${storage.hashRefreshToken(second.refresh_token)}`);
    expect(rt).toEqual({ grant_id: grantId, workspace_id: null });
    const [g] = await q<{ acts_as: string }>(sql`SELECT acts_as FROM mcp_oauth_grants WHERE id = ${grantId}::uuid`);
    expect(g.acts_as).toBe('agent');
    const acct = await authenticateApiKey(second.access_token) as Record<string, unknown> | null;
    expect(acct?.actsAs).toBe('agent');
    expect(acct?.sessionUserId).toBeUndefined();
  });

  test('refresh after the grant is revoked is refused, revokes the family, and names no id', async () => {
    const { userId, a, clientId } = await setup();
    const grantId = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId] });
    const first = await exchange(userId, grantId, clientId);
    const spare = await storage.createRefreshToken({ clientId, userId, grantId, scope: 'mcp' });
    await q(sql`UPDATE mcp_oauth_grants SET revoked_at = now() WHERE id = ${grantId}::uuid`);

    const res = await tokenPost({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe('invalid_grant');
    for (const id of [grantId, a.workspaceId, a.teamId, userId]) expect(text).not.toContain(id);
    const [s] = await q<{ revoked_at: string | null }>(sql`SELECT revoked_at FROM oauth_refresh_tokens WHERE token = ${storage.hashRefreshToken(spare)}`);
    expect(s.revoked_at).not.toBeNull();
  });

  test('refresh after membership loss is refused', async () => {
    const { userId, a, clientId } = await setup();
    const grantId = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId] });
    const first = await exchange(userId, grantId, clientId);
    await q(sql`DELETE FROM team_members WHERE team_id = ${a.teamId}::uuid AND user_id = ${userId}::uuid`);
    const res = await tokenPost({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(a.workspaceId);
  });

  test('a code for a grant issued to another client is refused', async () => {
    const { userId, a, clientId } = await setup();
    const otherClient = await client();
    const grantId = await grant({ userId, clientId, actsAs: 'person', workspaceIds: [a.workspaceId] });
    const { code, verifier } = await codeFor(userId, grantId, otherClient);
    const res = await tokenPost({ grant_type: 'authorization_code', code, client_id: otherClient, redirect_uri: 'https://client.example/cb', code_verifier: verifier });
    expect(res.status).toBe(400);
  });

  test('a legacy workspace refresh token still rotates as before', async () => {
    const { userId, a, clientId } = await setup();
    const legacy = await storage.createRefreshToken({ clientId, userId, workspaceId: a.workspaceId, scope: 'mcp' });
    const res = await tokenPost({ grant_type: 'refresh_token', refresh_token: legacy, client_id: clientId });
    expect(res.status).toBe(200);
    const body = await res.json() as { access_token: string };
    expect(await tokens.verifyAccessToken(body.access_token, a.workspaceId)).not.toBeNull();
  });
});

describe('person-only actions follow the grant kind', () => {
  async function grantedWorld(actsAs: 'person' | 'agent') {
    w = await world();
    const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w.workspaceId}::uuid`);
    const userId = await user();
    await member(ws.team_id, userId, 'owner');
    await teamAccount(ws.team_id);
    const clientId = await client();
    const grantId = await grant({ userId, clientId, actsAs, workspaceIds: [w.workspaceId] });
    return { w, teamId: ws.team_id, userId, jwt: await grantToken(userId, grantId, clientId) };
  }

  async function closedPrInMission(w: World, teamId: string) {
    const pr = await w.openPr({ branch: `feat/g-${rand()}`, files: { 'src/a.ts': 'export const a = 2;\n' } });
    const missionId = await seedMission(teamId, w.workspaceId);
    await q(sql`UPDATE tasks SET mission_id = ${missionId}::uuid WHERE id = ${pr.ownerTaskId}::uuid`);
    w.gh.closePr(w.repo, pr.prNumber);
    await w.deliver();
    return { pr, missionId };
  }

  const abandon = (missionId: string, taskId: string, jwt: string) => closedPrsRoute.POST(new NextRequest(`http://localhost/api/missions/${missionId}/closed-prs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ taskId, action: 'abandon', reason: 'plan changed' }),
  }) as never, { params: Promise.resolve({ id: missionId }) });

  test('an agent grant cannot Abandon', async () => {
    const g = await grantedWorld('agent');
    const { pr, missionId } = await closedPrInMission(g.w, g.teamId);
    const res = await abandon(missionId, pr.ownerTaskId, g.jwt);
    expect(res.status).toBe(403);
    expect((await g.w.delivery(pr)).state).toBe('CLOSED_UNMERGED');
    expect(await g.w.commands(pr)).not.toContain('Abandon');
  }, 60_000);

  test('a person grant can Abandon, as that person', async () => {
    const g = await grantedWorld('person');
    const { pr, missionId } = await closedPrInMission(g.w, g.teamId);
    const res = await abandon(missionId, pr.ownerTaskId, g.jwt);
    expect(res.status).toBe(200);
    expect((await g.w.delivery(pr)).state).toBe('ABANDONED');
    const [t] = await q<{ evidence: { actor?: string } }>(sql`
      SELECT evidence FROM workflow_transitions WHERE delivery_id = ${pr.deliveryId}::uuid AND command = 'Abandon'`);
    expect(t.evidence.actor).toBe(`human:${g.userId}`);
  }, 60_000);

  async function reviewedPr(w: World) {
    const pr = await w.openPr({ branch: `feat/r-${rand()}`, files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    w.gh.greenCi(w.repo, pr.head, ['build', 'test']);
    await w.deliver();
    await w.verdict(pr, await w.reviewer(pr), 'request_changes', pr.head);
    expect(await w.delivery(pr)).toMatchObject({ state: 'CHANGES_REQUESTED', currentRound: 1 });
    return pr;
  }
  const forceReview = (w: World, prNumber: number, jwt: string) => reviewRoute.POST(new NextRequest('http://localhost/api/github/pr/review', {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prNumber, workspaceId: w.workspaceId, force: true }),
  }) as never);

  test('an agent grant cannot force a review', async () => {
    const g = await grantedWorld('agent');
    const pr = await reviewedPr(g.w);
    const res = await forceReview(g.w, pr.prNumber, g.jwt);
    expect(res.status).toBe(409);
    expect(await g.w.delivery(pr)).toMatchObject({ state: 'CHANGES_REQUESTED', currentRound: 1 });
  }, 60_000);

  test('a person grant can force a review', async () => {
    const g = await grantedWorld('person');
    const pr = await reviewedPr(g.w);
    const res = await forceReview(g.w, pr.prNumber, g.jwt);
    expect(res.status).toBeLessThan(300);
    expect(await g.w.delivery(pr)).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2 });
  }, 60_000);
});

/**
 * Cross-team negative matrix for account-level MCP grant sessions, on real
 * Postgres (docs/specs/auth-oauth-boundaries.md, "Grant sessions on REST").
 *
 * A grant session authenticates as its team's SHARED session account, so every
 * handler that used to decide reach from `account.teamId`, the account's links
 * or "same account" would let one granted workspace reach the rest of the team.
 * The rule (lib/grant-scope.ts) is: a grant session reaches exactly its granted
 * workspaces ∩ the user's current memberships, independent of links and of
 * access_mode, and nothing else. A mocked `db` would hide every WHERE clause
 * that decides this, so each surface runs here on real rows.
 *
 * World, per case:
 *  - team A: `granted` (left `restricted`, the default, with no account link)
 *    and `sibling` (open, NOT granted);
 *  - team B: `foreign` (open), whose repo has the same name as `granted`'s;
 *    the user is a member of B, but nothing in B is granted;
 *  - the user is owner of A, so the session acts at admin level: any refusal
 *    below is the grant's, never the role's.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

process.env.AUTH_SECRET ||= 'grant-scope-matrix-test-secret-0123456789abcdef';
process.env.OAUTH_ISSUER = 'https://issuer.example';
process.env.NEXTAUTH_URL = 'http://self.example';
delete process.env.VERCEL_URL;

const grants = await import('../../src/lib/mcp-grants');
const tokens = await import('../../src/lib/oauth/tokens');
const storage = await import('../../src/lib/oauth/storage');
const { authenticateApiKey, authenticateGrantSession, clearAccountCache, GRANT_WORKSPACE_HEADER } = await import('../../src/lib/api-auth');
const { verifyAccountWorkspaceAccess } = await import('../../src/lib/team-access');
const { listReachableWorkspaceIds, resolveWorkspaceAccess } = await import('../../src/lib/workspace-access');
const { resolveWorkerByPrNumber } = await import('../../src/lib/pr-resolve');
const { canActOnWorkerPr } = await import('../../src/lib/worker-pr-access');
const { taskScopeAllowsWorker, taskScopeAllowsWorkspace } = await import('../../src/lib/task-token-auth');
const tasksRoute = await import('../../src/app/api/tasks/route');
const bulkRoute = await import('../../src/app/api/tasks/bulk/route');
const claimRoute = await import('../../src/app/api/workers/claim/route');
const mineRoute = await import('../../src/app/api/workers/mine/route');
const workspacesRoute = await import('../../src/app/api/workspaces/route');
const matchReposRoute = await import('../../src/app/api/workspaces/match-repos/route');

beforeAll(() => assertDbConfigured());
afterEach(() => clearAccountCache());

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
    INSERT INTO accounts (type, name, api_key, team_id, auth_type, level, max_concurrent_workers)
    VALUES ('user', ${key}, ${key}, ${teamId}::uuid, 'oauth', 'admin', 10) RETURNING id`);
  return a.id;
}
/** A plain bld_ admin key on a team, with no account_workspaces links. */
async function apiKey(teamId: string): Promise<{ key: string; id: string }> {
  const key = `bld_${rand()}${rand()}`;
  const hash = new Bun.CryptoHasher('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, auth_type) VALUES ('service', ${`svc-${rand()}`}, ${hash}, ${teamId}::uuid, 'admin', 'api') RETURNING id`);
  return { key, id: a.id };
}
async function client(): Promise<string> {
  const { clientId } = await storage.createClient({ clientName: 'test', redirectUris: ['https://client.example/cb'] });
  return clientId;
}
async function grantToken(o: { userId: string; clientId: string; workspaceIds: string[]; scopes?: Array<'read' | 'write'> }) {
  const r = await grants.createGrant({ ...o, actsAs: 'person', scopes: o.scopes ?? ['read', 'write'] });
  if (!r.ok) throw new Error(`createGrant: ${r.error}`);
  const { token } = await tokens.signGrantAccessToken({ userId: o.userId, grantId: r.grantId, clientId: o.clientId, scope: 'mcp' });
  return { jwt: token, grantId: r.grantId };
}
async function worker(workspaceId: string, accountId: string, o: { taskId?: string; prNumber?: number; status?: string } = {}): Promise<string> {
  const [wk] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, account_id, task_id, name, runner, branch, status, pr_number, pr_url)
    VALUES (${workspaceId}::uuid, ${accountId}::uuid, ${o.taskId ?? null}::uuid, ${`w-${rand()}`}, 'mcp', ${`b-${rand()}`},
      ${o.status ?? 'completed'}, ${o.prNumber ?? null}, ${o.prNumber ? `https://github.com/org/repo/pull/${o.prNumber}` : null})
    RETURNING id`);
  return wk.id;
}

async function setup(o: { scopes?: Array<'read' | 'write'>; extraGranted?: boolean } = {}) {
  const userId = await user();
  const a = await seedWorkspace();
  const b = await seedWorkspace();
  const repoName = `repo-${rand()}`;
  // granted: restricted (the column default), no account link.
  await q(sql`UPDATE workspaces SET repo = ${`org-a/${repoName}`} WHERE id = ${a.workspaceId}::uuid`);
  const [sib] = await q<{ id: string }>(sql`
    INSERT INTO workspaces (name, team_id, access_mode, repo) VALUES (${`sib-${rand()}`}, ${a.teamId}::uuid, 'open', ${`org-a/sib-${rand()}`}) RETURNING id`);
  // Same-named repo in the other team.
  await q(sql`UPDATE workspaces SET access_mode = 'open', repo = ${`org-b/${repoName}`} WHERE id = ${b.workspaceId}::uuid`);
  let second: string | null = null;
  if (o.extraGranted) {
    const [x] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id) VALUES (${`a2-${rand()}`}, ${a.teamId}::uuid) RETURNING id`);
    second = x.id;
  }
  await member(a.teamId, userId, 'owner');
  await member(b.teamId, userId, 'owner');
  const accountA = await teamAccount(a.teamId);
  await teamAccount(b.teamId);
  const clientId = await client();
  const { jwt, grantId } = await grantToken({ userId, clientId, workspaceIds: second ? [a.workspaceId, second] : [a.workspaceId], scopes: o.scopes });
  return {
    userId, jwt, grantId, accountA, repoName,
    teamA: a.teamId, teamB: b.teamId,
    granted: a.workspaceId, second, sibling: sib.id, foreign: b.workspaceId,
  };
}
type S = Awaited<ReturnType<typeof setup>>;

/** Exactly what the canonical MCP transport's self-call sends. */
function req(s: S, path: string, o: { method?: string; body?: unknown; bound?: string | null } = {}): NextRequest {
  const headers: Record<string, string> = { authorization: `Bearer ${s.jwt}`, 'content-type': 'application/json' };
  const bound = o.bound === undefined ? s.granted : o.bound;
  if (bound) headers[GRANT_WORKSPACE_HEADER] = bound;
  return new NextRequest(`http://localhost${path}`, { method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
async function session(s: S, bound: string = s.granted) {
  const acct = await authenticateGrantSession(s.jwt, bound);
  if (!acct) throw new Error('no grant session');
  return acct;
}

describe('restricted-mode reach: grant ∩ membership, not the shared account\'s links', () => {
  test('a grant session reaches the restricted workspace it was granted, with no account link', async () => {
    const s = await setup();
    const acct = await session(s);
    expect(await verifyAccountWorkspaceAccess(acct, s.granted)).toBe(true);
    expect(await verifyAccountWorkspaceAccess(acct, s.granted, 'canCreate')).toBe(true);
    expect(await listReachableWorkspaceIds({ account: acct })).toEqual([s.granted]);
    const r = await resolveWorkspaceAccess(s.granted, { account: acct }, 'canCreate');
    expect(r.ok).toBe(true);
  });

  test('…and nothing else: an open sibling in the same team and the other team are unreachable', async () => {
    const s = await setup();
    const acct = await session(s);
    for (const ws of [s.sibling, s.foreign]) {
      expect(await verifyAccountWorkspaceAccess(acct, ws)).toBe(false);
      expect((await resolveWorkspaceAccess(ws, { account: acct })).ok).toBe(false);
    }
    // Passing only the shared account's id would have judged the shared
    // account instead: the open sibling. That is why callers pass the session.
    expect(await verifyAccountWorkspaceAccess(s.accountA, s.sibling)).toBe(true);
  });

  test('a bld_ key on the same team still cannot reach the restricted workspace without a link', async () => {
    const s = await setup();
    const k = await apiKey(s.teamA);
    expect(await verifyAccountWorkspaceAccess(k.id, s.granted)).toBe(false);
    const acct = await authenticateApiKey(k.key, new NextRequest('http://localhost/api/tasks', { method: 'POST' }));
    expect(acct).not.toBeNull();
    expect(await listReachableWorkspaceIds({ account: acct! })).not.toContain(s.granted);
    const res = await tasksRoute.POST(new NextRequest('http://localhost/api/tasks', {
      method: 'POST', headers: { authorization: `Bearer ${k.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: s.granted, title: `key-${rand()}`, description: 'd', kind: 'engineering' }),
    }));
    expect(res.status).toBe(403);
  });

  test('a read-only grant reaches its workspace for reads only', async () => {
    const s = await setup({ scopes: ['read'] });
    const acct = await session(s);
    expect(await verifyAccountWorkspaceAccess(acct, s.granted)).toBe(true);
    expect(await verifyAccountWorkspaceAccess(acct, s.granted, 'canCreate')).toBe(false);
  });
});

describe('tasks', () => {
  test('create lands in the granted restricted workspace, and never in an ungranted one', async () => {
    const s = await setup();
    const title = `t-${rand()}`;
    const ok = await tasksRoute.POST(req(s, '/api/tasks', { method: 'POST', body: { workspaceId: s.granted, title, description: 'd', kind: 'engineering' } }));
    expect(ok.status).toBeLessThan(300);
    for (const ws of [s.sibling, s.foreign]) {
      const res = await tasksRoute.POST(req(s, '/api/tasks', { method: 'POST', body: { workspaceId: ws, title, description: 'd', kind: 'engineering' } }));
      expect(res.status).toBe(401);
    }
    const rows = await q<{ workspace_id: string }>(sql`SELECT workspace_id FROM tasks WHERE title = ${title}`);
    expect(rows.map(r => r.workspace_id)).toEqual([s.granted]);
  });

  test('a create with no workspaceId uses the one granted workspace, never the shared account\'s link', async () => {
    const s = await setup();
    // The shared team account is linked to the sibling: a link-based
    // auto-resolve would pick it.
    await q(sql`INSERT INTO account_workspaces (account_id, workspace_id, can_claim, can_create) VALUES (${s.accountA}::uuid, ${s.sibling}::uuid, true, true)`);
    const title = `t-${rand()}`;
    const res = await tasksRoute.POST(req(s, '/api/tasks', { method: 'POST', body: { title, description: 'd', kind: 'engineering' } }));
    expect(res.status).toBeLessThan(300);
    const rows = await q<{ workspace_id: string }>(sql`SELECT workspace_id FROM tasks WHERE title = ${title}`);
    expect(rows.map(r => r.workspace_id)).toEqual([s.granted]);
  });

  test('a list must name the workspace, and an ungranted one is no session', async () => {
    const s = await setup();
    const mine = await seedTask(s.granted, { title: `g-${rand()}` });
    await seedTask(s.sibling, { title: `s-${rand()}` });
    const ok = await tasksRoute.GET(req(s, `/api/tasks?workspaceId=${s.granted}`));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { tasks: Array<{ id: string; workspaceId: string }> };
    expect(body.tasks.map(t => t.id)).toContain(mine);
    expect(body.tasks.every(t => t.workspaceId === s.granted)).toBe(true);
    expect((await tasksRoute.GET(req(s, '/api/tasks'))).status).toBe(401);
    expect((await tasksRoute.GET(req(s, `/api/tasks?workspaceId=${s.sibling}`))).status).toBe(401);
  });

  test('a task by id in an ungranted workspace is no session', async () => {
    const s = await setup();
    const sibTask = await seedTask(s.sibling);
    const foreignTask = await seedTask(s.foreign);
    for (const id of [sibTask, foreignTask]) {
      expect(await authenticateApiKey(s.jwt, req(s, `/api/tasks/${id}`))).toBeNull();
    }
    expect(await authenticateApiKey(s.jwt, req(s, `/api/tasks/${await seedTask(s.granted)}`))).not.toBeNull();
  });

  test('bulk cancel touches only granted workspaces, even with no workspaceId', async () => {
    const s = await setup();
    await q(sql`INSERT INTO account_workspaces (account_id, workspace_id, can_claim, can_create) VALUES (${s.accountA}::uuid, ${s.sibling}::uuid, true, true)`);
    const g = await seedTask(s.granted);
    const sib = await seedTask(s.sibling);
    const res = await bulkRoute.POST(req(s, '/api/tasks/bulk', { method: 'POST', body: { action: 'cancel', status: 'pending' } }));
    expect(res.status).toBe(200);
    const rows = await q<{ id: string; status: string }>(sql`SELECT id, status FROM tasks WHERE id IN (${g}::uuid, ${sib}::uuid)`);
    expect(rows.find(r => r.id === g)?.status).toBe('cancelled');
    expect(rows.find(r => r.id === sib)?.status).toBe('pending');
  });

  test('the team-wide cleanup sweep is refused', async () => {
    const s = await setup();
    expect(await authenticateApiKey(s.jwt, req(s, '/api/tasks/cleanup', { method: 'POST', body: {} }))).toBeNull();
  });
});

describe('missions, memory, schedules, artifacts, analytics', () => {
  test('a mission in an ungranted workspace is no session; a create must name a granted workspace', async () => {
    const s = await setup();
    const sibMission = await seedMission(s.teamA, s.sibling);
    expect(await authenticateApiKey(s.jwt, req(s, `/api/missions/${sibMission}`))).toBeNull();
    expect(await authenticateApiKey(s.jwt, req(s, `/api/missions/${await seedMission(s.teamA, s.granted)}`))).not.toBeNull();
    expect(await authenticateApiKey(s.jwt, req(s, '/api/missions', { method: 'POST', body: { title: 'm' } }))).toBeNull();
    expect(await authenticateApiKey(s.jwt, req(s, '/api/missions', { method: 'POST', body: { title: 'm', workspaceId: s.sibling } }))).toBeNull();
    expect(await authenticateApiKey(s.jwt, req(s, '/api/missions', { method: 'POST', body: { title: 'm', workspaceId: s.granted } }))).not.toBeNull();
  });

  test('memory and schedules: only the granted workspace\'s', async () => {
    const s = await setup();
    for (const sub of ['memory', 'schedules', 'skills', 'artifacts', 'settings']) {
      expect(await authenticateApiKey(s.jwt, req(s, `/api/workspaces/${s.sibling}/${sub}`))).toBeNull();
      expect(await authenticateApiKey(s.jwt, req(s, `/api/workspaces/${s.foreign}/${sub}`))).toBeNull();
      expect(await authenticateApiKey(s.jwt, req(s, `/api/workspaces/${s.granted}/${sub}`))).not.toBeNull();
    }
  });

  test('team-wide collections and analytics need a granted filter', async () => {
    const s = await setup();
    for (const path of ['/api/artifacts', '/api/workers/active', '/api/roles', '/api/stats/usage', '/api/health/failures', '/api/health/budget', '/api/prs', '/api/missions']) {
      expect(await authenticateApiKey(s.jwt, req(s, path))).toBeNull();
    }
    expect(await authenticateApiKey(s.jwt, req(s, `/api/stats/usage?workspace=${s.granted}`))).not.toBeNull();
    expect(await authenticateApiKey(s.jwt, req(s, `/api/stats/usage?workspace=${s.sibling}`))).toBeNull();
    expect(await authenticateApiKey(s.jwt, req(s, `/api/prs?workspaceId=${s.granted}`))).not.toBeNull();
  });
});

describe('admin and runner surfaces', () => {
  test('a team owner\'s write grant reaches no team-administration surface', async () => {
    const s = await setup();
    const acct = await session(s);
    expect(acct.level).toBe('admin');
    const paths: Array<[string, string]> = [
      ['GET', '/api/secrets'], ['POST', '/api/secrets'], ['GET', '/api/accounts'], ['POST', '/api/accounts'],
      ['GET', `/api/teams/${s.teamA}`], ['GET', `/api/teams/${s.teamA}/members`], ['GET', '/api/model-tiers'],
      ['GET', '/api/connectors'], ['GET', '/api/providers'], ['GET', '/api/experiments'], ['GET', '/api/evidence-backends'],
      ['POST', '/api/workspaces'],
    ];
    for (const [method, path] of paths) {
      expect(await authenticateApiKey(s.jwt, req(s, path, { method, body: method === 'GET' ? undefined : { workspaceId: s.granted } }))).toBeNull();
    }
  });

  test('runner plumbing is refused', async () => {
    const s = await setup();
    for (const path of ['/api/runner/github-token', '/api/runner/model-endpoint', '/api/runner/task-token', '/api/workers/heartbeat', '/api/knowledge/ingest-jobs/claim', '/api/quality-scout/runs/claim', '/api/webhooks/ingest']) {
      expect(await authenticateApiKey(s.jwt, req(s, path, { method: 'POST', body: { workspaceId: s.granted } }))).toBeNull();
    }
  });
});

describe('PRs: same-numbered PRs in sibling and same-named foreign repos', () => {
  test('a PR number resolves only in the granted workspace', async () => {
    const s = await setup();
    const acct = await session(s);
    const prNumber = 4000 + Math.floor(Math.random() * 1000);
    // The same PR number in the sibling only: invisible.
    const sibWorker = await worker(s.sibling, s.accountA, { prNumber });
    const missing = await resolveWorkerByPrNumber(acct, prNumber, null);
    expect(typeof missing.status).toBe('number');
    // Now in the granted workspace too: that one, and never the sibling's.
    const mine = await worker(s.granted, s.accountA, { prNumber });
    const found = await resolveWorkerByPrNumber(acct, prNumber, null) as { id: string };
    expect(found.id).toBe(mine);
    // Naming the sibling explicitly does not reach it either.
    const named = await resolveWorkerByPrNumber(acct, prNumber, s.sibling) as { id?: string };
    expect(named.id).not.toBe(sibWorker);
  });

  test('a worker on the shared account in an ungranted workspace is not the session\'s to act on', async () => {
    const s = await setup();
    const acct = await session(s);
    const sibWorker = { accountId: s.accountA, workspaceId: s.sibling, workspace: { id: s.sibling, teamId: s.teamA }, taskId: null };
    expect(await canActOnWorkerPr(acct, sibWorker)).toBe(false);
    expect(taskScopeAllowsWorker(acct, sibWorker)).toBe(false);
    expect(taskScopeAllowsWorkspace(acct, s.sibling)).toBe(false);
    const mineWorker = { accountId: s.accountA, workspaceId: s.granted, workspace: { id: s.granted, teamId: s.teamA }, taskId: null };
    expect(await canActOnWorkerPr(acct, mineWorker)).toBe(true);
    expect(taskScopeAllowsWorkspace(acct, s.granted)).toBe(true);
  });

  test('workers/mine lists only the granted workspace\'s workers of the shared account', async () => {
    const s = await setup();
    const mine = await worker(s.granted, s.accountA);
    const other = await worker(s.sibling, s.accountA);
    // Claimed by this session's user: workers/mine lists only a grant user's own claims.
    await q(sql`UPDATE workers SET claimed_by_user_id = ${s.userId}::uuid WHERE id IN (${mine}::uuid, ${other}::uuid)`);
    const res = await mineRoute.GET(req(s, '/api/workers/mine'));
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { workers: Array<{ id: string }> }).workers.map(x => x.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(other);
  });
});

describe('workspace discovery: same-named repos, rename, move', () => {
  test('listing and repo matching show only the granted workspace', async () => {
    const s = await setup();
    const list = await workspacesRoute.GET(req(s, '/api/workspaces'));
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).toContain(s.granted);
    for (const id of [s.sibling, s.foreign]) expect(text).not.toContain(id);

    const match = await matchReposRoute.POST(req(s, '/api/workspaces/match-repos', {
      method: 'POST',
      body: { repos: [{ path: '/x', remoteUrl: `https://github.com/org-a/${s.repoName}` }, { path: '/y', remoteUrl: `https://github.com/org-b/${s.repoName}` }] },
    }));
    const matched = await match.text();
    expect(matched).toContain(s.granted);
    expect(matched).not.toContain(s.foreign);
    expect(matched).not.toContain(s.sibling);
  });

  test('a sibling renamed to the granted workspace\'s name does not resolve by that name', async () => {
    const s = await setup();
    const [{ name }] = await q<{ name: string }>(sql`SELECT name FROM workspaces WHERE id = ${s.granted}::uuid`);
    await q(sql`UPDATE workspaces SET name = ${name} WHERE id = ${s.sibling}::uuid`);
    const r = await resolveWorkspaceAccess(name, { account: await session(s) });
    expect(r.ok && r.workspace.id).toBe(s.granted);
  });

  test('a granted workspace moved to a team the user is not in stops being reachable on the next call', async () => {
    const s = await setup();
    expect(await authenticateApiKey(s.jwt, req(s, `/api/tasks?workspaceId=${s.granted}`))).not.toBeNull();
    const elsewhere = await seedWorkspace();
    await q(sql`UPDATE workspaces SET team_id = ${elsewhere.teamId}::uuid WHERE id = ${s.granted}::uuid`);
    expect(await authenticateApiKey(s.jwt, req(s, `/api/tasks?workspaceId=${s.granted}`))).toBeNull();
    expect(await authenticateGrantSession(s.jwt, s.granted)).toBeNull();
  });
});

describe('revocation and membership loss, mid-session', () => {
  test('a revoked grant creates nothing on the next call', async () => {
    const s = await setup();
    const title = `t-${rand()}`;
    const body = { workspaceId: s.granted, title, description: 'd', kind: 'engineering' };
    expect((await tasksRoute.POST(req(s, '/api/tasks', { method: 'POST', body }))).status).toBeLessThan(300);
    await q(sql`UPDATE mcp_oauth_grants SET revoked_at = now() WHERE id = ${s.grantId}::uuid`);
    expect((await tasksRoute.POST(req(s, '/api/tasks', { method: 'POST', body }))).status).toBe(401);
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM tasks WHERE title = ${title}`);
    expect(n).toBe(1);
  });

  test('removing the user from the team stops the session on the next call', async () => {
    const s = await setup();
    expect(await verifyAccountWorkspaceAccess(await session(s), s.granted)).toBe(true);
    await q(sql`DELETE FROM team_members WHERE team_id = ${s.teamA}::uuid AND user_id = ${s.userId}::uuid`);
    expect(await authenticateGrantSession(s.jwt, s.granted)).toBeNull();
    expect((await tasksRoute.GET(req(s, `/api/tasks?workspaceId=${s.granted}`))).status).toBe(401);
  });
});

describe('claims', () => {
  const claim = (s: S, body: Record<string, unknown>, bound: string | null) =>
    claimRoute.POST(req(s, '/api/workers/claim', { method: 'POST', body: { runner: `r-${rand()}`, maxTasks: 5, ...body }, bound }));
  const claimedTaskIds = async (res: Response) => ((await res.json()) as { workers?: Array<{ taskId: string }> }).workers?.map(w => w.taskId) ?? [];

  test('a bound claim takes only the granted workspace\'s task, never an open sibling\'s', async () => {
    const s = await setup();
    const g = await seedTask(s.granted, { title: `g-${rand()}` });
    const sib = await seedTask(s.sibling, { title: `s-${rand()}` });
    const res = await claim(s, { workspaceId: s.granted }, s.granted);
    expect(res.status).toBe(200);
    const ids = await claimedTaskIds(res);
    expect(ids).toContain(g);
    expect(ids).not.toContain(sib);
    // Naming the sibling is no session at all.
    expect((await claim(s, { workspaceId: s.sibling }, s.granted)).status).toBe(401);
  });

  test('claimAcrossAccessible must be the literal true, and then spans granted workspaces only', async () => {
    const s = await setup({ extraGranted: true });
    const g1 = await seedTask(s.granted, { title: `g1-${rand()}` });
    const g2 = await seedTask(s.second!, { title: `g2-${rand()}` });
    const sib = await seedTask(s.sibling, { title: `s-${rand()}` });
    // Unbound: a one-team grant of two workspaces authenticates without a binding.
    const ambiguous = await claim(s, {}, null);
    expect(ambiguous.status).toBe(400);
    const truthy = await claim(s, { claimAcrossAccessible: 'true' }, null);
    expect(truthy.status).toBe(400);
    const across = await claim(s, { claimAcrossAccessible: true }, null);
    expect(across.status).toBe(200);
    const ids = await claimedTaskIds(across);
    expect(ids.sort()).toEqual([g1, g2].sort());
    expect(ids).not.toContain(sib);
  });
});

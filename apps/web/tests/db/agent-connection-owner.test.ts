/**
 * An agent connection's workers belong to the person who connected it, on
 * real Postgres (docs/specs/auth-oauth-boundaries.md, "Grant sessions on
 * REST", AC-56..AC-60).
 *
 * Every grant session in a team authenticates as the team's one shared
 * session account. A 'person' grant carries the person (sessionUserId); an
 * 'agent' grant does not (it is never a person), so the user it was granted by
 * (oauthUserId) is what tells one member's agent from another's. A claim
 * records that user on the worker (workers.claimed_by_user_id), and every
 * check of "is this my worker" compares it.
 *
 * World, per case: one team, one workspace, users A and B both members with
 * an agent grant on that workspace. A mocked `db` would hide the WHERE
 * clauses that decide this, so it runs on real rows.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

process.env.AUTH_SECRET ||= 'agent-connection-owner-test-secret-0123456789ab';
process.env.OAUTH_ISSUER = 'https://issuer.example';
process.env.NEXTAUTH_URL = 'http://self.example';
delete process.env.VERCEL_URL;

const grants = await import('../../src/lib/mcp-grants');
const tokens = await import('../../src/lib/oauth/tokens');
const storage = await import('../../src/lib/oauth/storage');
const { authenticateGrantSession, clearAccountCache, GRANT_WORKSPACE_HEADER } = await import('../../src/lib/api-auth');
const { callerOwnsWorker } = await import('../../src/lib/worker-owner');
const { ownedByCaller } = await import('../../src/lib/worker-park');
const { authorizeWorkerPrCapability, agentRunMayActOnPr } = await import('../../src/lib/agent-capabilities/worker-pr');
const { db } = await import('@buildd/core/db');
const { workers } = await import('@buildd/core/db/schema');
const claimRoute = await import('../../src/app/api/workers/claim/route');
const mineRoute = await import('../../src/app/api/workers/mine/route');
const workerRoute = await import('../../src/app/api/workers/[id]/route');
const prRoute = await import('../../src/app/api/github/pr/route');

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

interface Conn { userId: string; jwt: string }

async function connect(userId: string, clientId: string, workspaceId: string, actsAs: 'person' | 'agent'): Promise<Conn> {
  const r = await grants.createGrant({ userId, clientId, workspaceIds: [workspaceId], actsAs, scopes: ['read', 'write'] });
  if (!r.ok) throw new Error(`createGrant: ${r.error}`);
  const { token } = await tokens.signGrantAccessToken({ userId, grantId: r.grantId, clientId, scope: 'mcp' });
  return { userId, jwt: token };
}

async function setup() {
  const ws = await seedWorkspace();
  const a = await user();
  const b = await user();
  await member(ws.teamId, a);
  await member(ws.teamId, b);
  const key = `k-${rand()}`;
  const [acct] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, auth_type, level, max_concurrent_workers)
    VALUES ('user', ${key}, ${key}, ${ws.teamId}::uuid, 'oauth', 'admin', 10) RETURNING id`);
  const { clientId } = await storage.createClient({ clientName: 'test', redirectUris: ['https://client.example/cb'] });
  return {
    workspaceId: ws.workspaceId,
    teamId: ws.teamId,
    sharedAccountId: acct.id,
    clientId,
    agentA: await connect(a, clientId, ws.workspaceId, 'agent'),
    agentB: await connect(b, clientId, ws.workspaceId, 'agent'),
  };
}
type S = Awaited<ReturnType<typeof setup>>;

function req(s: S, c: Conn, path: string, o: { method?: string; body?: unknown } = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: o.method ?? 'GET',
    headers: { authorization: `Bearer ${c.jwt}`, 'content-type': 'application/json', [GRANT_WORKSPACE_HEADER]: s.workspaceId },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
}
async function session(s: S, c: Conn) {
  const acct = await authenticateGrantSession(c.jwt, s.workspaceId);
  if (!acct) throw new Error('no grant session');
  return acct;
}

/** A claims one task through the real claim route; returns its worker row. */
async function claimAs(s: S, c: Conn) {
  const taskId = await seedTask(s.workspaceId, { title: `t-${rand()}` });
  const res = await claimRoute.POST(req(s, c, '/api/workers/claim', {
    method: 'POST', body: { runner: `r-${rand()}`, maxTasks: 1, workspaceId: s.workspaceId, taskId },
  }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { workers?: Array<{ id: string; taskId: string }> };
  const claimed = body.workers?.find((w) => w.taskId === taskId);
  if (!claimed) throw new Error(`claim took nothing: ${JSON.stringify(body)}`);
  const row = await db.query.workers.findFirst({ where: eq(workers.id, claimed.id), with: { workspace: true, task: true } });
  if (!row) throw new Error('claimed worker missing');
  return row;
}

describe('an agent connection\'s claim is recorded against its user', () => {
  test('the claim records the connecting user, on the shared team account', async () => {
    const s = await setup();
    const w = await claimAs(s, s.agentA);
    expect(w.accountId).toBe(s.sharedAccountId);
    expect(w.claimedByUserId).toBe(s.agentA.userId);
  });

  test('both agents share one account, and only the claimer owns the worker', async () => {
    const s = await setup();
    const w = await claimAs(s, s.agentA);
    const a = await session(s, s.agentA);
    const b = await session(s, s.agentB);
    expect(a.id).toBe(b.id);
    expect(callerOwnsWorker(a, w)).toBe(true);
    expect(callerOwnsWorker(b, w)).toBe(false);
  });

  test('an agent connection does not own a worker a key claimed on the shared account', async () => {
    const s = await setup();
    const taskId = await seedTask(s.workspaceId, { title: `k-${rand()}`, status: 'assigned' });
    const [row] = await q<{ id: string }>(sql`
      INSERT INTO workers (workspace_id, account_id, task_id, name, runner, branch, status)
      VALUES (${s.workspaceId}::uuid, ${s.sharedAccountId}::uuid, ${taskId}::uuid, ${`w-${rand()}`}, 'runner', ${`b-${rand()}`}, 'running')
      RETURNING id`);
    const w = await db.query.workers.findFirst({ where: eq(workers.id, row.id) });
    expect(callerOwnsWorker(await session(s, s.agentA), w!)).toBe(false);
  });
});

describe('only the claimer\'s connection sees and acts as the worker', () => {
  test('workers/mine lists it for A, not for B', async () => {
    const s = await setup();
    const w = await claimAs(s, s.agentA);
    const ids = async (c: Conn) => {
      const res = await mineRoute.GET(req(s, c, '/api/workers/mine'));
      expect(res.status).toBe(200);
      return ((await res.json()) as { workers: Array<{ id: string }> }).workers.map((x) => x.id);
    };
    expect(await ids(s.agentA)).toContain(w.id);
    expect(await ids(s.agentB)).not.toContain(w.id);
  });

  test('B cannot read, update or complete it; A can', async () => {
    const s = await setup();
    const w = await claimAs(s, s.agentA);
    const path = `/api/workers/${w.id}`;
    const params = { params: Promise.resolve({ id: w.id }) };

    expect((await workerRoute.GET(req(s, s.agentB, path), params)).status).toBe(403);
    expect((await workerRoute.PATCH(req(s, s.agentB, path, { method: 'PATCH', body: { status: 'running', progress: 10 } }), params)).status).toBe(403);
    expect((await workerRoute.PATCH(req(s, s.agentB, path, { method: 'PATCH', body: { status: 'completed', summary: 'x' } }), params)).status).toBe(403);
    const after = await db.query.workers.findFirst({ where: eq(workers.id, w.id), columns: { status: true } });
    expect(after?.status).toBe(w.status);

    expect((await workerRoute.GET(req(s, s.agentA, path), params)).status).toBe(200);
    const ok = await workerRoute.PATCH(req(s, s.agentA, path, { method: 'PATCH', body: { status: 'running', progress: 10 } }), params);
    expect(ok.status).toBe(200);
    const running = await db.query.workers.findFirst({ where: eq(workers.id, w.id), columns: { status: true } });
    expect(running?.status).toBe('running');
  });

  test('the conditional UPDATE predicate matches the worker for A only', async () => {
    const s = await setup();
    const w = await claimAs(s, s.agentA);
    const match = async (c: Conn) => (await db.select({ id: workers.id }).from(workers)
      .where(and(eq(workers.id, w.id), ownedByCaller(await session(s, c))))).length;
    expect(await match(s.agentA)).toBe(1);
    expect(await match(s.agentB)).toBe(0);
  });
});

describe('only the claimer\'s connection acts on the worker\'s PR as its owner', () => {
  test('creating, closing or merging through the worker is the claimer\'s alone', async () => {
    const s = await setup();
    const w = await claimAs(s, s.agentA);
    await q(sql`UPDATE workers SET pr_number = 41, pr_url = 'https://github.com/org/repo/pull/41' WHERE id = ${w.id}::uuid`);
    const withPr = (await db.query.workers.findFirst({ where: eq(workers.id, w.id), with: { workspace: true, task: true } }))!;
    const a = await session(s, s.agentA);
    const b = await session(s, s.agentB);

    const aCreate = await authorizeWorkerPrCapability(a, withPr, 'pr.create');
    expect(aCreate.allowed).toBe(true);
    expect(await agentRunMayActOnPr(a, withPr, 41)).toBe(true);

    expect((await authorizeWorkerPrCapability(b, withPr, 'pr.create')).allowed).toBe(false);
    expect(await agentRunMayActOnPr(b, withPr, 41)).toBe(false);
  });

  test('B\'s create_pr for A\'s worker is refused before anything reaches GitHub', async () => {
    const s = await setup();
    const w = await claimAs(s, s.agentA);
    const res = await prRoute.POST(req(s, s.agentB, '/api/github/pr', {
      method: 'POST', body: { workerId: w.id, title: 'feat: x', head: w.branch, lede: 'A change.' },
    }));
    expect(res.status).toBe(403);
  });
});

describe('person connections keep working', () => {
  test('a person connection owns what it claimed, and another member\'s person connection does not', async () => {
    const s = await setup();
    const personA = await connect(s.agentA.userId, s.clientId, s.workspaceId, 'person');
    const personB = await connect(s.agentB.userId, s.clientId, s.workspaceId, 'person');
    const w = await claimAs(s, personA);
    expect(w.claimedByUserId).toBe(personA.userId);
    expect(callerOwnsWorker(await session(s, personA), w)).toBe(true);
    expect(callerOwnsWorker(await session(s, personB), w)).toBe(false);
    // B's agent is no closer than B in person.
    expect(callerOwnsWorker(await session(s, s.agentB), w)).toBe(false);
  });
});

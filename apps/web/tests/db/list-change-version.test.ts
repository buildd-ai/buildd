/**
 * The change version on list reads, against real Postgres (spec 3ef37387
 * R-20, R-35, AC-4).
 *
 *  - AC-4: a list read sent with the current change version gets 304 and
 *    reads no list rows (counted at the neon-http wire: only the caller's
 *    reach, which is resolved fresh on every read).
 *  - R-35: a second reader at the same version, sending no version, gets the
 *    first reader's body from the cache, again reading no list rows.
 *  - Reach is never cached: after an unlink, a switch to restricted access, a
 *    move to another team or a team removal, the very next read drops the
 *    workspace (or team).
 *  - Read-your-writes: a task created through the API is in the same
 *    caller's very next list read, cached body or not.
 *  - A write of work bumps the version (the work-change listener resolves the
 *    task to its workspace in SQL), so the next read reads again.
 *  - Another caller never gets the first caller's cached body.
 *
 * The real routes with API-key auth; the counters and bodies are an in-memory
 * stand-in for Upstash (lib/change-version.ts memoryChangeVersionStore).
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { recordNeonQueries } from '@buildd/core/db';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

assertDbConfigured();

const realAuthHelpers = await import('../../src/lib/auth-helpers');
// `after()` as in a live request: queued until the response is long gone (the
// test runs the queue only when it says so), so nothing a write defers can
// stand in for a bump the write should have made before answering.
const afterQueue: Array<() => unknown> = [];
const realNextServer = await import('next/server');
mock.module('next/server', () => ({ ...realNextServer, after: (task: () => unknown) => { afterQueue.push(task); } }));

let sessionUser: { id: string } | null = null;
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => sessionUser }));

const { NextRequest } = realNextServer;
const recentRoute = await import('../../src/app/api/missions/recent/route');
const tasksRoute = await import('../../src/app/api/tasks/route');
const missionsRoute = await import('../../src/app/api/missions/route');
const cv = await import('../../src/lib/change-version');
const workChanged = await import('../../src/lib/work-changed');
const { invalidateAccountWorkspaceCache } = await import('../../src/lib/account-workspace-cache');

const DB_TIMEOUT_MS = 30_000;
const store = cv.memoryChangeVersionStore();
cv.setChangeVersionStoreForTests(store);

async function serviceKey(teamId: string, level: 'worker' | 'admin' = 'worker'): Promise<{ id: string; key: string }> {
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hashed = createHash('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${hashed}, ${teamId}::uuid, ${level}, 10) RETURNING id`);
  return { id: a.id, key };
}

const get = (route: { GET: (req: any) => Promise<Response> }, url: string, key: string | null, etag?: string) =>
  route.GET(new NextRequest(url, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(etag ? { 'if-none-match': etag } : {}) } }));

/** What the caller's reach reads (resolved fresh on every list read); no list row lives here. */
const REACH_TABLES = new Set(['accounts', 'account_workspaces', 'workspaces', 'teams', 'team_members']);

/** Call and count every query that reached the database, and those that read list rows. */
async function counted(fn: () => Promise<Response>) {
  let res!: Response;
  const rec = await recordNeonQueries(async () => { res = await fn(); });
  const listQueries = rec.queries.filter(qq => !REACH_TABLES.has(String(qq.table)));
  return { res, queries: rec.count, listQueries: listQueries.length, tables: rec.queries.map(qq => qq.table) };
}

const taskIdsOf = async (res: Response) => ((await res.json()) as { tasks: Array<{ id: string }> }).tasks.map(t => t.id);
const missionIdsOf = async (res: Response) => ((await res.json()) as { missions: Array<{ id: string }> }).missions.map(m => m.id);

let teamId: string;
let workspaceId: string;
let a: { id: string; key: string };
let b: { id: string; key: string };
let taskId: string;

beforeAll(async () => {
  ({ teamId, workspaceId } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${workspaceId}::uuid`);
  await q(sql`INSERT INTO missions (team_id, workspace_id, title, status) VALUES (${teamId}::uuid, ${workspaceId}::uuid, 'Versioned mission', 'active')`);
  taskId = await seedTask(workspaceId);
  a = await serviceKey(teamId);
  b = await serviceKey(teamId);
  // Warm each key's auth (its first use writes last_used_at, once a minute).
  await get(recentRoute, 'http://localhost/api/missions/recent?warm=1', a.key);
  await get(recentRoute, 'http://localhost/api/missions/recent?warm=1', b.key);
}, 60_000);

describe.each([
  ['/api/missions/recent', recentRoute],
  ['/api/tasks', tasksRoute],
  ['/api/missions', missionsRoute],
] as const)('%s', (path, route) => {
  const url = `http://localhost${path}`;

  test('AC-4: the current version gets 304 with no query; R-35: a second reader gets the cached body with no query', async () => {
    const first = await counted(() => get(route, url, a.key));
    expect(first.res.status).toBe(200);
    expect(first.queries).toBeGreaterThan(0);
    const etag = first.res.headers.get('etag');
    expect(etag).toMatch(/^W\/"cv1-/);
    const body = await first.res.text();

    const again = await counted(() => get(route, url, a.key, etag!));
    expect(again.res.status).toBe(304);
    expect(again.listQueries).toBe(0);
    expect(again.queries).toBeLessThan(first.queries);
    expect(await again.res.text()).toBe('');

    const second = await counted(() => get(route, url, a.key));
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get('x-buildd-list-cache')).toBe('hit');
    expect(second.listQueries).toBe(0);
    expect(second.res.headers.get('etag')).toBe(etag);
    expect(await second.res.text()).toBe(body);
  }, DB_TIMEOUT_MS);

  test('another caller is never served the first caller\'s body or tag', async () => {
    const mine = await get(route, url, a.key);
    const etag = mine.headers.get('etag')!;
    const theirs = await counted(() => get(route, url, b.key, etag));
    expect(theirs.res.status).toBe(200);
    expect(theirs.queries).toBeGreaterThan(0);
    expect(theirs.res.headers.get('etag')).not.toBe(etag);
  }, DB_TIMEOUT_MS);

  test('a write of work moves the version, and the next read reads again', async () => {
    const before = await get(route, url, a.key);
    const etag = before.headers.get('etag')!;
    await q(sql`UPDATE tasks SET priority = priority + 1 WHERE id = ${taskId}::uuid`);
    await cv.changeVersionWorkListener({ missionIds: [], taskIds: [taskId], workerIds: [], prs: [], workspacePrs: [] });
    const after = await counted(() => get(route, url, a.key, etag));
    expect(after.res.status).toBe(200);
    expect(after.queries).toBeGreaterThan(0);
    expect(after.res.headers.get('etag')).not.toBe(etag);
  }, DB_TIMEOUT_MS);
});

describe('scopesOfWorkChange', () => {
  test('resolves tasks, missions and workspace PRs to their workspace and team in one statement', async () => {
    const [m] = await q<{ id: string }>(sql`SELECT id FROM missions WHERE workspace_id = ${workspaceId}::uuid LIMIT 1`);
    const rec = await recordNeonQueries(async () => {
      const scopes = await cv.scopesOfWorkChange({
        missionIds: [m.id], taskIds: [taskId, 'not-a-uuid'], workerIds: [], prs: [], workspacePrs: [{ workspaceId, prNumber: 7 }],
      });
      expect(scopes).toEqual([workspaceId, cv.teamChangeScope(teamId)].sort());
    });
    expect(rec.count).toBe(1);
    expect(await cv.scopesOfWorkChange({ missionIds: [], taskIds: [], workerIds: [], prs: [], workspacePrs: [] })).toEqual([]);
  }, DB_TIMEOUT_MS);
});

// ── Reach is resolved fresh: an access change takes effect on the next read ──

describe('access changes take effect on the very next list read', () => {
  const TASKS = 'http://localhost/api/tasks';
  const MISSIONS = 'http://localhost/api/missions';

  test('an account_workspaces unlink drops the linked workspace', async () => {
    const home = await seedWorkspace();
    const other = await seedWorkspace();
    await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${home.workspaceId}::uuid`);
    const homeTask = await seedTask(home.workspaceId);
    const linkedTask = await seedTask(other.workspaceId);
    const k = await serviceKey(home.teamId);
    await q(sql`INSERT INTO account_workspaces (account_id, workspace_id, can_claim, can_create) VALUES (${k.id}::uuid, ${other.workspaceId}::uuid, true, false)`);

    const before = await get(tasksRoute, TASKS, k.key);
    expect(await taskIdsOf(before)).toEqual(expect.arrayContaining([homeTask, linkedTask]));
    const etag = before.headers.get('etag')!;

    await q(sql`DELETE FROM account_workspaces WHERE account_id = ${k.id}::uuid AND workspace_id = ${other.workspaceId}::uuid`);
    // What the unlink routes do with the link cache (lib/account-workspace-cache.ts, its own clear hook).
    invalidateAccountWorkspaceCache(k.id);
    const fresh = await get(tasksRoute, TASKS, k.key);
    expect(fresh.headers.get('x-buildd-list-cache')).toBeNull();
    const ids = await taskIdsOf(fresh);
    expect(ids).toContain(homeTask);
    expect(ids).not.toContain(linkedTask);
    // The old ETag is no longer current either.
    expect((await get(tasksRoute, TASKS, k.key, etag)).status).toBe(200);
  }, DB_TIMEOUT_MS);

  test('a switch to restricted access drops a home-team workspace the account has no link to', async () => {
    const home = await seedWorkspace();
    await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${home.workspaceId}::uuid`);
    const t = await seedTask(home.workspaceId);
    const k = await serviceKey(home.teamId);
    expect(await taskIdsOf(await get(tasksRoute, TASKS, k.key))).toContain(t);

    await q(sql`UPDATE workspaces SET access_mode = 'restricted' WHERE id = ${home.workspaceId}::uuid`);
    expect(await taskIdsOf(await get(tasksRoute, TASKS, k.key))).not.toContain(t);
  }, DB_TIMEOUT_MS);

  test('a workspace moved to another team drops out', async () => {
    const home = await seedWorkspace();
    const elsewhere = await seedWorkspace();
    await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${home.workspaceId}::uuid`);
    const t = await seedTask(home.workspaceId);
    const k = await serviceKey(home.teamId);
    expect(await taskIdsOf(await get(tasksRoute, TASKS, k.key))).toContain(t);

    await q(sql`UPDATE workspaces SET team_id = ${elsewhere.teamId}::uuid WHERE id = ${home.workspaceId}::uuid`);
    expect(await taskIdsOf(await get(tasksRoute, TASKS, k.key))).not.toContain(t);
  }, DB_TIMEOUT_MS);

  test('a person removed from a team loses its workspaces and missions', async () => {
    const team = await seedWorkspace();
    const t = await seedTask(team.workspaceId);
    const [m] = await q<{ id: string }>(sql`INSERT INTO missions (team_id, workspace_id, title, status) VALUES (${team.teamId}::uuid, ${team.workspaceId}::uuid, 'Team mission', 'active') RETURNING id`);
    const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`p-${crypto.randomUUID()}@example.test`}) RETURNING id`);
    await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${team.teamId}::uuid, ${u.id}::uuid, 'member')`);
    sessionUser = { id: u.id };
    try {
      expect(await taskIdsOf(await get(tasksRoute, TASKS, null))).toContain(t);
      expect(await missionIdsOf(await get(missionsRoute, MISSIONS, null))).toContain(m.id);

      await q(sql`DELETE FROM team_members WHERE team_id = ${team.teamId}::uuid AND user_id = ${u.id}::uuid`);
      expect(await taskIdsOf(await get(tasksRoute, TASKS, null))).not.toContain(t);
      expect(await missionIdsOf(await get(missionsRoute, MISSIONS, null))).not.toContain(m.id);
    } finally {
      sessionUser = null;
    }
  }, DB_TIMEOUT_MS);
});

// ── Read-your-writes: the version moves before the create answers ─────────

describe('create then list', () => {
  test('a task created through the API is in the same caller\'s next list read', async () => {
    const home = await seedWorkspace();
    await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${home.workspaceId}::uuid`);
    const admin = await serviceKey(home.teamId, 'admin');
    // Noting on (a test process notes nothing otherwise), with the real bump.
    workChanged.setWorkChangeListenersForTests([]);
    workChanged.setWorkChangeVersionBumperForTests(cv.changeVersionWorkListener);
    try {
      const url = `http://localhost/api/tasks?workspaceId=${home.workspaceId}`;
      const before = await get(tasksRoute, url, admin.key);
      expect(before.status).toBe(200);
      const etag = before.headers.get('etag')!;
      // Primed: the same read again is a cache hit.
      expect((await get(tasksRoute, url, admin.key)).headers.get('x-buildd-list-cache')).toBe('hit');

      const title = `ryw-${crypto.randomUUID()}`;
      const created = await tasksRoute.POST(new NextRequest('http://localhost/api/tasks', {
        method: 'POST', headers: { authorization: `Bearer ${admin.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: home.workspaceId, title, description: 'd', kind: 'engineering' }),
      }));
      expect(created.status).toBeLessThan(300);
      const { id } = (await created.json()) as { id: string };

      // No waiting, no flush, nothing deferred has run: the bump landed before POST answered.
      const after = await get(tasksRoute, url, admin.key, etag);
      expect(after.status).toBe(200);
      expect(after.headers.get('x-buildd-list-cache')).toBeNull();
      expect(await taskIdsOf(after)).toContain(id);
    } finally {
      workChanged.setWorkChangeListenersForTests(null);
      workChanged.setWorkChangeVersionBumperForTests(null);
      afterQueue.length = 0;
    }
  }, DB_TIMEOUT_MS);
});

/**
 * The change version on list reads, against real Postgres (spec 3ef37387
 * R-20, R-35, AC-4).
 *
 *  - AC-4: a list read sent with the current change version gets 304 and
 *    reads no list rows (counted at the neon-http wire: no query at all).
 *  - R-35: a second reader at the same version, sending no version, gets the
 *    first reader's body from the cache, again with no query.
 *  - A write of work bumps the version (the work-change listener resolves the
 *    task to its workspace in SQL), so the next read reads again.
 *  - Another caller never gets the first caller's cached body.
 *
 * The real routes with API-key auth; the counters and bodies are an in-memory
 * stand-in for Upstash (lib/change-version.ts memoryChangeVersionStore).
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { recordNeonQueries } from '@buildd/core/db';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

assertDbConfigured();

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

const recentRoute = await import('../../src/app/api/missions/recent/route');
const tasksRoute = await import('../../src/app/api/tasks/route');
const missionsRoute = await import('../../src/app/api/missions/route');
const cv = await import('../../src/lib/change-version');

const DB_TIMEOUT_MS = 30_000;
const store = cv.memoryChangeVersionStore();
cv.setChangeVersionStoreForTests(store);

async function serviceKey(teamId: string): Promise<{ id: string; key: string }> {
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hashed = createHash('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${hashed}, ${teamId}::uuid, 'worker', 10) RETURNING id`);
  return { id: a.id, key };
}

const get = (route: { GET: (req: any) => Promise<Response> }, url: string, key: string, etag?: string) =>
  route.GET(new NextRequest(url, { headers: { authorization: `Bearer ${key}`, ...(etag ? { 'if-none-match': etag } : {}) } }));

/** Call and count every query that reached the database. */
async function counted(fn: () => Promise<Response>) {
  let res!: Response;
  const rec = await recordNeonQueries(async () => { res = await fn(); });
  return { res, queries: rec.count };
}

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
    expect(again.queries).toBe(0);
    expect(await again.res.text()).toBe('');

    const second = await counted(() => get(route, url, a.key));
    expect(second.res.status).toBe(200);
    expect(second.queries).toBe(0);
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

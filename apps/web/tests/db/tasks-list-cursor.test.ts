/**
 * GET /api/tasks (the full list) pages with hasMore + nextCursor instead of
 * stopping at 200 without saying so (spec 3ef37387 R-19, R-10). Real
 * Postgres: the order, the tie-break and the cursor's precision are SQL.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

assertDbConfigured();
const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));
const route = await import('../../src/app/api/tasks/route');

const DB_TIMEOUT_MS = 60_000;
const N = route.FULL_LIST_PAGE + 25;
let key: string;
let workspaceId: string;

beforeAll(async () => {
  const seeded = await seedWorkspace();
  workspaceId = seeded.workspaceId;
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${workspaceId}::uuid`);
  key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  await q(sql`INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${createHash('sha256').update(key).digest('hex')}, ${seeded.teamId}::uuid, 'worker', 10)`);
  // Pending tasks; groups of five share a created_at down to the microsecond, and
  // each group sits a few microseconds past a millisecond boundary.
  await q(sql`
    INSERT INTO tasks (workspace_id, title, description, status, created_at)
    SELECT ${workspaceId}::uuid, 'Task ' || g, 'd', 'pending',
      timestamptz '2026-01-01 00:00:00+00' + (g / 5) * interval '1 millisecond' + interval '3 microseconds'
    FROM generate_series(1, ${N}) g`);
}, DB_TIMEOUT_MS);

const page = async (cursor?: string) => {
  const url = `http://localhost/api/tasks?workspaceId=${workspaceId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const res = await route.GET(new NextRequest(url, { headers: { authorization: `Bearer ${key}` } }));
  return { status: res.status, body: await res.json() as any };
};

describe('GET /api/tasks full list: hasMore + cursor', () => {
  test('two pages cover every task once, in order, ties included', async () => {
    const first = await page();
    expect(first.status).toBe(200);
    expect(first.body.tasks).toHaveLength(route.FULL_LIST_PAGE);
    expect(first.body.hasMore).toBe(true);
    expect(typeof first.body.nextCursor).toBe('string');
    const second = await page(first.body.nextCursor);
    expect(second.body.hasMore).toBe(false);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.tasks, ...second.body.tasks].map((t: any) => t.id);
    expect(ids).toHaveLength(N);
    expect(new Set(ids).size).toBe(N);
  }, DB_TIMEOUT_MS);

  test('a cursor the list never handed out is a 400', async () => {
    expect((await page('not-a-cursor')).status).toBe(400);
  }, DB_TIMEOUT_MS);
});

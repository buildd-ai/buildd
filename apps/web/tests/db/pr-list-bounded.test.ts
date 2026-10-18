/**
 * `list_prs` reads what it shows (spec 3ef37387 R-22), on real Postgres: for
 * open and merged it takes the newest PRs only, and a PR whose newest row
 * merged still collapses out of the open list even when an older row of it is
 * open. A mocked db cannot see the candidate subquery's LIMIT.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const { listPrsQuery } = await import('../../src/lib/pr-list');

const MIN = 60_000;
const NOW = Date.now();

async function prWorker(workspaceId: string, n: number, startedMinAgo: number, opts: { mergedAt?: Date | null; status?: string } = {}) {
  const taskId = await seedTask(workspaceId, { status: 'completed' });
  await q(sql`
    INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_number, pr_url, pr_lifecycle_status, merged_at, started_at)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, ${`w-${n}-${startedMinAgo}`}, 'test', ${`b-${n}`}, 'completed', ${n},
      ${`https://github.com/acme/app/pull/${n}`}, ${opts.status ?? 'pr_open'}, ${opts.mergedAt?.toISOString() ?? null}::timestamptz,
      ${new Date(NOW - startedMinAgo * MIN).toISOString()}::timestamptz)`);
}

let ws: string;

beforeAll(async () => {
  assertDbConfigured();
  ws = (await seedWorkspace()).workspaceId;
  // Ten open PRs, #1 oldest … #10 newest.
  for (let n = 1; n <= 10; n++) await prWorker(ws, n, 100 - n);
  // #11: opened long ago, its newest row merged: not open.
  await prWorker(ws, 11, 500);
  await prWorker(ws, 11, 1, { mergedAt: new Date(NOW - MIN), status: 'merged' });
});

describe('listPrsQuery reads only the newest PRs for open and merged', () => {
  test('open, limit 3: the three newest open PRs', async () => {
    const prs = await listPrsQuery({ workspaceIds: [ws], state: 'open', limit: 3 });
    expect(prs.map(p => p.prNumber).sort((a, b) => b! - a!)).toEqual([10, 9, 8]);
  });

  test('a PR whose newest row merged is not open, whatever its older row says', async () => {
    const prs = await listPrsQuery({ workspaceIds: [ws], state: 'open', limit: 50 });
    expect(prs.map(p => p.prNumber)).not.toContain(11);
    expect(prs).toHaveLength(10);
  });

  test('merged lists it', async () => {
    const prs = await listPrsQuery({ workspaceIds: [ws], state: 'merged', limit: 5, since: new Date(NOW - 60 * MIN) });
    expect(prs.map(p => p.prNumber)).toEqual([11]);
  });

  test('attention still reads every open PR (decided after the collapse)', async () => {
    await expect(listPrsQuery({ workspaceIds: [ws], state: 'attention', limit: 3 })).resolves.toBeArray();
  });
});

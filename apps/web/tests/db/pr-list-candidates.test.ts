/**
 * list_prs / GET /api/prs reads a bounded set of candidate PRs in SQL
 * (spec 3ef37387 R-10, R-22), newest first, instead of scanning up to a
 * thousand worker rows per call, and still collapses each PR over all of its
 * rows.
 *
 * Also the first real-database run of the open-PR read: it selected
 * `mission_notes.abandoned_at`, which does not exist, so every open or
 * attention list with an open PR failed in the query builder.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { recordNeonQueries } from '@buildd/core/db';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

assertDbConfigured();

const { listPrsQuery, prCandidateCap } = await import('../../src/lib/pr-list');

const DB_TIMEOUT_MS = 60_000;
const PRS = 120;
let workspaceId: string;

beforeAll(async () => {
  ({ workspaceId } = await seedWorkspace());
  const taskId = await seedTask(workspaceId);
  // PR n started n minutes ago: PR 1 is the newest. PR 2 has a later row that closed it.
  await q(sql`
    INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_url, pr_number, started_at)
    SELECT ${workspaceId}::uuid, ${taskId}::uuid, 'w-' || g, 'r', 'b-' || g, 'completed',
      'https://github.com/example/repo/pull/' || g, g, now() - g * interval '1 minute'
    FROM generate_series(1, ${PRS}) g`);
  await q(sql`
    INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_url, pr_number, pr_lifecycle_status, started_at)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w-2b', 'r', 'b-2', 'completed',
      'https://github.com/example/repo/pull/2', 2, 'closed', now() - interval '30 seconds')`);
}, DB_TIMEOUT_MS);

describe('listPrsQuery candidates', () => {
  test('a page reads the newest PRs only, and a PR closed by a later row stays out', async () => {
    let page: Awaited<ReturnType<typeof listPrsQuery>> = [];
    const rec = await recordNeonQueries(async () => {
      page = await listPrsQuery({ workspaceIds: [workspaceId], state: 'open', limit: 5 });
    });
    expect(page.map(p => p.prNumber)).toEqual([1, 3, 4, 5, 6]);
    // The rows read are bounded by the candidate cap, not by how many PRs the workspace has.
    const wide = await recordNeonQueries(async () => { await listPrsQuery({ workspaceIds: [workspaceId], state: 'open', limit: 50 }); });
    expect(rec.bytes).toBeLessThan(wide.bytes / 2);
  }, DB_TIMEOUT_MS);

  test('the PR attention read runs on real Postgres (it selected a column mission_notes does not have)', async () => {
    const page = await listPrsQuery({ workspaceIds: [workspaceId], state: 'attention', limit: 5 });
    expect(Array.isArray(page)).toBe(true);
  }, DB_TIMEOUT_MS);

  test('candidate cap: headroom over the page, every open PR for attention, never above the maximum', () => {
    expect(prCandidateCap('open', 5)).toBe(30);
    expect(prCandidateCap('open', 50)).toBe(150);
    expect(prCandidateCap('attention', 5)).toBe(200);
    expect(prCandidateCap('merged', 100)).toBe(200);
  });
});

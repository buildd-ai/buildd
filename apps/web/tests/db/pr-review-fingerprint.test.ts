/**
 * The PR review wait's fingerprint (lib/pr-review-request.ts
 * prReviewFingerprint) on real Postgres: one statement, stable while nothing
 * it covers changes, moved by a write to the PR's worker, its review task, or
 * a reviewer worker, and blind to another PR.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { recordNeonQueries } from '@buildd/core/db';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

assertDbConfigured();
const { prReviewFingerprint } = await import('../../src/lib/pr-review-request');

let ws: string;
let ownerWorker: string;
let reviewTask: string;
beforeAll(async () => {
  ({ workspaceId: ws } = await seedWorkspace());
  const owner = await seedTask(ws);
  [{ id: ownerWorker }] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_url, pr_number)
    VALUES (${ws}::uuid, ${owner}::uuid, 'w', 'r', 'b', 'completed', 'https://github.com/example/repo/pull/7', 7) RETURNING id`);
  reviewTask = await seedTask(ws);
  await q(sql`UPDATE tasks SET category = 'review', context = '{"prNumber": 7}'::jsonb WHERE id = ${reviewTask}::uuid`);
});

const print = () => prReviewFingerprint({ workspaceId: ws, prNumber: 7 });

describe('prReviewFingerprint', () => {
  test('one statement, and stable while nothing changes', async () => {
    let a: string | null = null;
    const rec = await recordNeonQueries(async () => { a = await print(); });
    expect(rec.count).toBe(1);
    expect(a).toMatch(/^1:.+\|1:.+$/);
    expect(await print()).toBe(a);
  });

  test('moves on a write to the PR worker, the review task, or a new reviewer worker', async () => {
    const p0 = await print();
    await q(sql`UPDATE workers SET updated_at = now() + interval '1 second' WHERE id = ${ownerWorker}::uuid`);
    const p1 = await print();
    expect(p1).not.toBe(p0);
    await q(sql`UPDATE tasks SET updated_at = now() + interval '2 seconds' WHERE id = ${reviewTask}::uuid`);
    const p2 = await print();
    expect(p2).not.toBe(p1);
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status) VALUES (${ws}::uuid, ${reviewTask}::uuid, 'rv', 'r', 'b2', 'running')`);
    expect(await print()).not.toBe(p2);
  });

  test('another PR does not move it', async () => {
    const before = await print();
    const other = await seedTask(ws);
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_url, pr_number)
      VALUES (${ws}::uuid, ${other}::uuid, 'o', 'r', 'b3', 'completed', 'https://github.com/example/repo/pull/8', 8)`);
    expect(await print()).toBe(before);
  });
});

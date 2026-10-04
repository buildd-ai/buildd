/**
 * Retry and requeue wakes, against real Postgres. The unit tests pin that each
 * retry path calls wakeTask with its cause; this pins what that call does to
 * the outbox the trigger already wrote: the cause lands on the same row, and a
 * deferred requeue stays undeliverable until its start time.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { claimDueDispatchesSql, enqueueDispatchSql } from '@buildd/core/dispatch-outbox';
import { assertDbConfigured, outboxFor, q, seedTask, seedWorkspace } from './harness';

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

describe('retry wakes coalesce into the trigger row', () => {
  test('a CI-fix insert plus its ci.retry wake is one pending row with both causes', async () => {
    const [t] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, title, status, ci_retry_pr_number, ci_retry_head_sha)
      VALUES (${workspaceId}::uuid, 'CI retry', 'pending', 42, ${`sha-${Date.now()}`})
      RETURNING id`);
    await db.execute(enqueueDispatchSql({ taskId: t.id, cause: 'ci.retry' }));

    const rows = await outboxFor(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', dedupe_key: 'now' });
    expect(rows[0].causes).toEqual(['task.created', 'ci.retry']);
  });
});

describe('a budget-wall requeue waits for its reset', () => {
  test('pending with a future start_at is one scheduled row, not claimable before start_at', async () => {
    const id = await seedTask(workspaceId, { status: 'in_progress' });
    expect(await outboxFor(id)).toHaveLength(0);

    // What the budget-wall branch writes, then the wake it sends after it.
    const resetsAt = new Date(Math.ceil((Date.now() + 3_600_000) / 1000) * 1000);
    await db.execute(sql`
      UPDATE tasks SET status = 'pending', claimed_by = NULL, start_at = ${resetsAt.toISOString()}::timestamptz
      WHERE id = ${id}::uuid`);
    await db.execute(enqueueDispatchSql({ taskId: id, cause: 'budget.available', notBefore: resetsAt }));

    const rows = await outboxFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', dedupe_key: `start_at:${resetsAt.getTime()}` });
    expect(rows[0].causes).toEqual(['start_at.reached', 'budget.available']);
    expect(new Date(rows[0].not_before).getTime()).toBe(resetsAt.getTime());

    const early = await q<{ task_id: string }>(claimDueDispatchesSql(1000, new Date(resetsAt.getTime() - 1000).toISOString()));
    expect(early.map(r => r.task_id)).not.toContain(id);
    const atReset = await q<{ task_id: string }>(claimDueDispatchesSql(1000, new Date(resetsAt.getTime() + 1000).toISOString()));
    expect(atReset.map(r => r.task_id)).toContain(id);
  });
});

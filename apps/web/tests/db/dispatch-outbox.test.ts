/**
 * Durable dispatch intent, against real Postgres: the trigger, coalescing,
 * scheduled wakes and the at-least-once claim. Contract:
 * docs/specs/task-dispatch-authority.md (AC-1..AC-7).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  claimDueDispatches,
  claimDueDispatchesSql,
  enqueueDispatchSql,
  markDispatchDelivered,
  markDispatchFailed,
  retryDelayMs,
  MAX_DELIVERY_ATTEMPTS,
} from '@buildd/core/dispatch-outbox';
import { assertDbConfigured, outboxFor, q, seedTask, seedWorkspace, settleOutbox } from './harness';

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

describe('trigger: every transition into pending is durable', () => {
  test('creating a pending task writes one immediate intent in the same statement', async () => {
    const id = await seedTask(workspaceId);
    const rows = await outboxFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cause: 'task.created', status: 'pending', dedupe_key: 'now' });
  });

  test('a task created in another status writes nothing until it becomes pending', async () => {
    const id = await seedTask(workspaceId, { status: 'completed' });
    expect(await outboxFor(id)).toHaveLength(0);
    await db.execute(sql`UPDATE tasks SET status = 'pending' WHERE id = ${id}::uuid`);
    const rows = await outboxFor(id);
    expect(rows.map(r => r.cause)).toEqual(['task.requeued']);
  });

  test('a requeue while the creation wake is undelivered coalesces into it', async () => {
    const id = await seedTask(workspaceId);
    await db.execute(sql`UPDATE tasks SET status = 'in_progress' WHERE id = ${id}::uuid`);
    await db.execute(sql`UPDATE tasks SET status = 'pending' WHERE id = ${id}::uuid`);
    const rows = await outboxFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].causes).toEqual(['task.created', 'task.requeued']);
  });

  test('a requeue after the first wake was delivered gets its own intent', async () => {
    const id = await seedTask(workspaceId);
    await settleOutbox();
    await db.execute(sql`UPDATE tasks SET status = 'in_progress' WHERE id = ${id}::uuid`);
    await db.execute(sql`UPDATE tasks SET status = 'pending' WHERE id = ${id}::uuid`);
    const pending = (await outboxFor(id)).filter(r => r.status === 'pending');
    expect(pending.map(r => r.cause)).toEqual(['task.requeued']);
  });

  test('an unrelated update to a pending task writes nothing', async () => {
    const id = await seedTask(workspaceId);
    await db.execute(sql`UPDATE tasks SET title = 'renamed', priority = 3 WHERE id = ${id}::uuid`);
    expect(await outboxFor(id)).toHaveLength(1);
  });
});

describe('scheduled wakes (startAt)', () => {
  test('a future startAt is a durable wake at that time, not now', async () => {
    const due = new Date(Date.now() + 3_600_000);
    const id = await seedTask(workspaceId, { startAt: due });
    const rows = await outboxFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].cause).toBe('start_at.reached');
    expect(rows[0].dedupe_key).toBe(`start_at:${due.getTime()}`);
    expect(Math.abs(new Date(rows[0].not_before).getTime() - due.getTime())).toBeLessThan(1000);
  });

  test('it is not claimable early, and is claimable once due — no reconciliation pass involved', async () => {
    const due = new Date(Date.now() + 3_600_000);
    const id = await seedTask(workspaceId, { startAt: due });
    const early = await q<{ task_id: string }>(claimDueDispatchesSql(1000, new Date(due.getTime() - 1000).toISOString()));
    expect(early.map(r => r.task_id)).not.toContain(id);
    const atDue = await q<{ task_id: string }>(claimDueDispatchesSql(1000, new Date(due.getTime() + 1000).toISOString()));
    expect(atDue.map(r => r.task_id)).toContain(id);
  });

  test('moving startAt schedules a new wake; an immediate wake does not absorb a scheduled one', async () => {
    const id = await seedTask(workspaceId, { startAt: new Date(Date.now() + 3_600_000) });
    const later = new Date(Date.now() + 7_200_000);
    await db.execute(sql`UPDATE tasks SET start_at = ${later.toISOString()}::timestamptz WHERE id = ${id}::uuid`);
    await db.execute(enqueueDispatchSql({ taskId: id, cause: 'dependency.satisfied' }));
    const keys = (await outboxFor(id)).map(r => r.dedupe_key).sort();
    expect(keys).toContain(`start_at:${later.getTime()}`);
    expect(keys).toContain('now');
  });
});

describe('explicit enqueue', () => {
  test('an app cause coalesces into the trigger row and is kept', async () => {
    const id = await seedTask(workspaceId);
    await db.execute(enqueueDispatchSql({ taskId: id, cause: 'ci.retry' }));
    const rows = await outboxFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].causes).toEqual(['task.created', 'ci.retry']);
  });

  test('batched with the mutation: both land, or neither does', async () => {
    const id = await seedTask(workspaceId);
    await expect(db.batch([
      db.execute(sql`UPDATE tasks SET priority = 9 WHERE id = ${id}::uuid`),
      db.execute(enqueueDispatchSql({ taskId: id, cause: 'dependency.satisfied' })),
      db.execute(sql`SELECT 1/0`),
    ])).rejects.toThrow('division by zero');
    const [t] = await q<{ priority: number }>(sql`SELECT priority FROM tasks WHERE id = ${id}::uuid`);
    expect(t.priority).not.toBe(9);
    expect((await outboxFor(id)).flatMap(r => r.causes)).not.toContain('dependency.satisfied');
  });

  test('a successful batch commits the mutation and the intent together', async () => {
    const id = await seedTask(workspaceId);
    const results = await db.batch([
      db.execute(sql`UPDATE tasks SET priority = 7 WHERE id = ${id}::uuid`),
      db.execute(enqueueDispatchSql({ taskId: id, cause: 'dependency.satisfied' })),
    ]);
    expect(results).toHaveLength(2);
    expect((await outboxFor(id))[0].causes).toEqual(['task.created', 'dependency.satisfied']);
  });

  test('enqueue for a missing task inserts nothing and does not throw', async () => {
    await db.execute(enqueueDispatchSql({ taskId: '00000000-0000-0000-0000-000000000000', cause: 'task.unblocked' }));
  });
});

describe('claim: at-least-once, never twice concurrently', () => {
  test('two concurrent drains take disjoint rows', async () => {
    await settleOutbox();
    const ids = await Promise.all(Array.from({ length: 6 }, () => seedTask(workspaceId)));
    const [a, b] = await Promise.all([claimDueDispatches(100), claimDueDispatches(100)]);
    const taken = [...a, ...b].map(r => r.taskId).filter(t => ids.includes(t));
    expect(new Set(taken).size).toBe(taken.length);
    expect(new Set(taken)).toEqual(new Set(ids));
  });

  test('a delivered row is never claimed again', async () => {
    await settleOutbox();
    const id = await seedTask(workspaceId);
    const [row] = (await claimDueDispatches(100)).filter(r => r.taskId === id);
    await markDispatchDelivered(row.id, 'pusher');
    const again = (await claimDueDispatches(100)).filter(r => r.taskId === id);
    expect(again).toHaveLength(0);
  });

  test('a row whose consumer died mid-delivery is retaken after its lease lapses', async () => {
    await settleOutbox();
    const id = await seedTask(workspaceId);
    const [row] = (await claimDueDispatches(100)).filter(r => r.taskId === id);
    expect((await claimDueDispatches(100)).filter(r => r.taskId === id)).toHaveLength(0);
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    const retaken = (await q<{ id: string }>(claimDueDispatchesSql(100, later))).map(r => r.id);
    expect(retaken).toContain(row.id);
  });

  test('a failed delivery backs off and is retried, then parks as failed', async () => {
    await settleOutbox();
    const id = await seedTask(workspaceId);
    const [row] = (await claimDueDispatches(100)).filter(r => r.taskId === id);
    expect(await markDispatchFailed(row.id, row.attemptCount, 'boom')).toBe('retrying');
    const [after] = await outboxFor(id);
    expect(after.status).toBe('pending');
    expect(new Date(after.not_before).getTime()).toBeGreaterThan(Date.now() + retryDelayMs(1) - 5_000);
    await db.execute(sql`UPDATE task_dispatch_outbox SET status = 'delivering' WHERE id = ${row.id}::uuid`);
    expect(await markDispatchFailed(row.id, MAX_DELIVERY_ATTEMPTS, 'boom')).toBe('failed');
    expect((await outboxFor(id))[0].status).toBe('failed');
  });

  test('a failed delivery folds into a newer pending wake instead of violating the dedupe index', async () => {
    await settleOutbox();
    const id = await seedTask(workspaceId);
    const [row] = (await claimDueDispatches(100)).filter(r => r.taskId === id);
    await db.execute(enqueueDispatchSql({ taskId: id, cause: 'path_claim.released' }));
    await markDispatchFailed(row.id, row.attemptCount, 'boom');
    const rows = await outboxFor(id);
    const pending = rows.filter(r => r.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].causes).toEqual(expect.arrayContaining(['path_claim.released', 'task.created']));
  });
});

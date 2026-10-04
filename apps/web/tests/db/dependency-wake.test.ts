/**
 * Dependency wakes, against real Postgres. A dependent stays `pending` when its
 * last dependency resolves, so the tasks trigger never sees the moment it
 * becomes runnable; `enqueueReadyDependentsSql` has to select exactly the
 * dependents that are now ready and write their intents in one statement.
 * Contract: docs/specs/task-dispatch-authority.md.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  enqueueReadyDependents,
  findPendingTasksWithResolvedDepsAndNoWake,
} from '@buildd/core/dispatch-dependents';
import { assertDbConfigured, outboxFor, q, seedTask, seedWorkspace } from './harness';

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

const complete = (id: string) => db.execute(sql`UPDATE tasks SET status = 'completed', updated_at = now() WHERE id = ${id}::uuid`);
const depWakes = async (id: string) => (await outboxFor(id)).filter(r => r.causes.includes('dependency.satisfied'));
const markDelivered = (id: string) => db.execute(sql`
  UPDATE task_dispatch_outbox SET status = 'delivered', delivered_via = 'test:settled', updated_at = now()
  WHERE task_id = ${id}::uuid AND status IN ('pending', 'delivering')`);

async function seedPrWorker(taskId: string, mergedAt: Date | null): Promise<void> {
  await q(sql`
    INSERT INTO workers (workspace_id, task_id, name, runner, branch, pr_url, pr_number, merged_at)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w', 'test', 'b', 'https://example.test/pr/1', 1, ${mergedAt?.toISOString() ?? null}::timestamptz)`);
}

describe('enqueueReadyDependents: the dependency.satisfied wake', () => {
  test('wakes the dependent whose deps are all resolved, not the one still blocked by another dep', async () => {
    const p = await seedTask(workspaceId, { status: 'in_progress' });
    const qDep = await seedTask(workspaceId, { status: 'in_progress' });
    const c1 = await seedTask(workspaceId, { dependsOn: [p] });
    const c2 = await seedTask(workspaceId, { dependsOn: [p, qDep] });

    await complete(p);
    const woken = await enqueueReadyDependents(p);

    expect(woken).toEqual([c1]);
    expect(await depWakes(c1)).toHaveLength(1);
    expect(await depWakes(c2)).toHaveLength(0);

    // Q resolving is C2's moment, through the same path.
    await complete(qDep);
    expect(await enqueueReadyDependents(qDep)).toEqual([c2]);
    expect(await depWakes(c2)).toHaveLength(1);
  });

  test('coalesces into the undelivered creation wake instead of adding a row', async () => {
    const p = await seedTask(workspaceId, { status: 'in_progress' });
    const c = await seedTask(workspaceId, { dependsOn: [p] });
    await complete(p);
    await enqueueReadyDependents(p);
    const rows = (await outboxFor(c)).filter(r => r.status === 'pending');
    expect(rows).toHaveLength(1);
    expect(rows[0].causes).toEqual(['task.created', 'dependency.satisfied']);
  });

  test('a dependency with an open PR does not satisfy; once merged it does', async () => {
    const p = await seedTask(workspaceId, { status: 'in_progress' });
    const c = await seedTask(workspaceId, { dependsOn: [p] });
    await seedPrWorker(p, null);
    await complete(p);
    expect(await enqueueReadyDependents(p)).toEqual([]);

    await db.execute(sql`UPDATE workers SET merged_at = now() WHERE task_id = ${p}::uuid`);
    expect(await enqueueReadyDependents(p)).toEqual([c]);
  });

  test('only the latest PR worker counts: an older merged PR does not hide a newer open one', async () => {
    const p = await seedTask(workspaceId, { status: 'in_progress' });
    await seedTask(workspaceId, { dependsOn: [p] });
    await seedPrWorker(p, new Date(Date.now() - 60_000));
    await db.execute(sql`UPDATE workers SET created_at = now() - interval '1 hour' WHERE task_id = ${p}::uuid`);
    await seedPrWorker(p, null);
    await complete(p);
    expect(await enqueueReadyDependents(p)).toEqual([]);
  });

  test('a looping dependency must reach satisfied', async () => {
    const p = await seedTask(workspaceId, { status: 'in_progress' });
    const c = await seedTask(workspaceId, { dependsOn: [p] });
    await db.execute(sql`UPDATE tasks SET status = 'completed', loop_state = 'running' WHERE id = ${p}::uuid`);
    expect(await enqueueReadyDependents(p)).toEqual([]);
    await db.execute(sql`UPDATE tasks SET loop_state = 'satisfied' WHERE id = ${p}::uuid`);
    expect(await enqueueReadyDependents(p)).toEqual([c]);
  });

  test('a missing or malformed dependency id blocks rather than erroring', async () => {
    const p = await seedTask(workspaceId, { status: 'in_progress' });
    const gone = await seedTask(workspaceId, { dependsOn: [p, '00000000-0000-4000-8000-000000000000'] });
    const junk = await seedTask(workspaceId, { dependsOn: [p, 'not-a-uuid'] });
    await complete(p);
    expect(await enqueueReadyDependents(p)).toEqual([]);
    expect(await depWakes(gone)).toHaveLength(0);
    expect(await depWakes(junk)).toHaveLength(0);
  });

  test('a dependent that is no longer pending is not woken', async () => {
    const p = await seedTask(workspaceId, { status: 'in_progress' });
    const c = await seedTask(workspaceId, { dependsOn: [p], status: 'cancelled' });
    await complete(p);
    expect(await enqueueReadyDependents(p)).toEqual([]);
    expect(await outboxFor(c)).toHaveLength(0);
  });
});

describe('findPendingTasksWithResolvedDepsAndNoWake: the reconciliation backstop', () => {
  const found = async (ids: string[]) => {
    const all = await findPendingTasksWithResolvedDepsAndNoWake({ limit: 500 });
    return ids.filter(id => all.includes(id));
  };

  test('finds a ready dependent whose wake was lost, and stops once one is written', async () => {
    const p = await seedTask(workspaceId, { status: 'in_progress' });
    const c = await seedTask(workspaceId, { dependsOn: [p] });
    await markDelivered(c); // creation wake, delivered while still blocked
    await complete(p); // ...and the enqueue after it never ran

    expect(await found([c])).toEqual([c]);
    await enqueueReadyDependents(p);
    expect(await found([c])).toEqual([]);
    // A wake delivered after the deps resolved still counts.
    await markDelivered(c);
    expect(await found([c])).toEqual([]);
  });

  test('ignores dependents that are still blocked, and ones with an undelivered wake', async () => {
    const p = await seedTask(workspaceId, { status: 'in_progress' });
    const blocked = await seedTask(workspaceId, { dependsOn: [p] });
    await markDelivered(blocked);
    expect(await found([blocked])).toEqual([]);

    const p2 = await seedTask(workspaceId, { status: 'in_progress' });
    const waiting = await seedTask(workspaceId, { dependsOn: [p2] }); // creation wake still pending
    await complete(p2);
    expect(await found([waiting])).toEqual([]);
  });

  test('a merge after completion moves the resolution time, so a wake from before it does not count', async () => {
    const p = await seedTask(workspaceId, { status: 'in_progress' });
    const c = await seedTask(workspaceId, { dependsOn: [p] });
    await seedPrWorker(p, null);
    await complete(p);
    await markDelivered(c);
    // Wake written and delivered while the PR was open — the claim deferred it.
    await db.execute(sql`UPDATE task_dispatch_outbox SET updated_at = now() - interval '1 minute' WHERE task_id = ${c}::uuid`);
    await db.execute(sql`UPDATE tasks SET updated_at = now() - interval '2 minutes' WHERE id = ${p}::uuid`);
    expect(await found([c])).toEqual([]); // PR open: not resolved
    await db.execute(sql`UPDATE workers SET merged_at = now() WHERE task_id = ${p}::uuid`);
    expect(await found([c])).toEqual([c]);
  });
});

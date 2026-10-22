/**
 * The wait exit (apps/web/src/lib/task-wait-exit.ts, Living Spec d25d923d
 * R-20 / AC-12) against real Postgres: an agent blocked by another task ends
 * its run waiting on it, and the existing dependency wake restarts the task
 * when that task merges, with no person in between.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { enqueueReadyDependents } from '@buildd/core/dispatch-dependents';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { applyWaitExit } from '@/lib/task-wait-exit';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

let workspaceId: string;
let gitConfig: unknown;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
  await db.execute(sql`UPDATE workspaces SET git_config = '{"waitOnTask": true}'::jsonb WHERE id = ${workspaceId}::uuid`);
  gitConfig = { waitOnTask: true };
});

async function liveWorker(taskId: string): Promise<string> {
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w', 'test', 'buildd/wait-exit', 'running') RETURNING id`);
  return w.id;
}

async function row(taskId: string) {
  const [t] = await q<{ status: string; depends_on: string[]; context: Record<string, any> | null; claimed_by: string | null }>(
    sql`SELECT status, depends_on, context, claimed_by FROM tasks WHERE id = ${taskId}::uuid`);
  return t;
}

const asTask = async (id: string) => {
  const [t] = await q<{ id: string; workspace_id: string; status: string; depends_on: string[] | null; context: unknown }>(
    sql`SELECT id, workspace_id, status, depends_on, context FROM tasks WHERE id = ${id}::uuid`);
  return { id: t.id, workspaceId: t.workspace_id, status: t.status, dependsOn: t.depends_on, context: t.context, deliveryId: null, gitConfig };
};

describe('applyWaitExit', () => {
  test('moves a running task to wait on its blocker, ends the worker, and the merge wakes it', async () => {
    const blocker = await seedTask(workspaceId, { status: 'in_progress', title: 'Runner image credentials' });
    const t = await seedTask(workspaceId, { status: 'in_progress' });
    const workerId = await liveWorker(t);

    const out = await applyWaitExit({ task: await asTask(t), blockerTaskId: blocker, reason: 'needs the registry credentials', workerId });
    expect(out.ok).toBe(true);

    const after = await row(t);
    expect(after.status).toBe('pending');
    expect(after.depends_on).toEqual([blocker]);
    expect(after.claimed_by).toBeNull();
    expect(after.context?.waitExit).toMatchObject({ blockerTaskId: blocker, reason: 'needs the registry credentials', workerId });
    expect(after.context?.resumeBranch).toBe('buildd/wait-exit');
    const [w] = await q<{ status: string }>(sql`SELECT status FROM workers WHERE id = ${workerId}::uuid`);
    expect(w.status).toBe('completed');

    // Not ready while the blocker is open; the blocker merging (no PR) wakes it.
    expect(await enqueueReadyDependents(blocker, depsGate())).toEqual([]);
    await db.execute(sql`UPDATE tasks SET status = 'completed', updated_at = now() WHERE id = ${blocker}::uuid`);
    expect(await enqueueReadyDependents(blocker, depsGate())).toEqual([t]);
  });

  test('refuses a cycle through another task, and writes nothing', async () => {
    const t = await seedTask(workspaceId, { status: 'in_progress' });
    const middle = await seedTask(workspaceId, { status: 'pending', dependsOn: [t] });
    const blocker = await seedTask(workspaceId, { status: 'pending', dependsOn: [middle] });
    const out = await applyWaitExit({ task: await asTask(t), blockerTaskId: blocker, reason: 'r' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.code).toBe('cycle');
    expect((await row(t)).status).toBe('in_progress');
  });

  test('refuses a blocker that already merged', async () => {
    const blocker = await seedTask(workspaceId, { status: 'completed' });
    const t = await seedTask(workspaceId, { status: 'in_progress' });
    const out = await applyWaitExit({ task: await asTask(t), blockerTaskId: blocker, reason: 'r' });
    expect(!out.ok && out.code).toBe('blocker_merged');
  });

  test('accepts a completed blocker whose PR is still open', async () => {
    const blocker = await seedTask(workspaceId, { status: 'completed' });
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, pr_url, pr_number) VALUES (${workspaceId}::uuid, ${blocker}::uuid, 'w', 'test', 'b', 'https://example.test/pr/9', 9)`);
    const t = await seedTask(workspaceId, { status: 'in_progress' });
    expect((await applyWaitExit({ task: await asTask(t), blockerTaskId: blocker, reason: 'r' })).ok).toBe(true);
  });

  test('refuses a task in another workspace', async () => {
    const other = await seedWorkspace();
    const blocker = await seedTask(other.workspaceId, { status: 'in_progress' });
    const t = await seedTask(workspaceId, { status: 'in_progress' });
    const out = await applyWaitExit({ task: await asTask(t), blockerTaskId: blocker, reason: 'r' });
    expect(!out.ok && out.code).toBe('unknown_blocker');
  });
});

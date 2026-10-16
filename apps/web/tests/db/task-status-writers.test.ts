/**
 * S4b (docs/specs/workflow-kernel-library.md §1, AC-1) on real Postgres: the writers of
 * `tasks.status` that INFER where a task's PR went (a merge seen by branch name, a stale-failure
 * archive sweep, a dependency's failure cascading) skip a delivery-owned task, whose lifecycle is
 * the kernel's transitions. A task with no delivery keeps today's writer, byte for byte.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const { completeTaskOnBranchMatchMerge } = await import('../../src/lib/pr-merged-legacy-task');
const { archiveStaleFailedTasks } = await import('../../src/lib/task-archive');
const { cascadeDependencyFailure } = await import('../../src/lib/task-dependencies');

let workspaceId: string;
let prSeq = 200_000 + Math.floor(Math.random() * 700_000);

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

/** A kernel-authority delivery owned by `taskId`, bound to a PR, in `state`. */
async function deliver(taskId: string, state = 'IN_REVIEW', authority = 'kernel') {
  await q(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, version, authority, repo_full_name, pr_number)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, ${state}, 3, ${authority}, 'acme/writers', ${prSeq++})`);
}
const status = async (taskId: string) => (await q<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${taskId}::uuid`))[0].status;
const age = (taskId: string) => q(sql`UPDATE tasks SET updated_at = now() - interval '40 days' WHERE id = ${taskId}::uuid`);

describe('branch-name match on a merged PR', () => {
  test('completes a task with no delivery, as before', async () => {
    const t = await seedTask(workspaceId, { status: 'in_progress' });
    expect(await completeTaskOnBranchMatchMerge(t)).toBe(true);
    expect(await status(t)).toBe('completed');
  });

  test('never completes a delivery-owned task: T17 does', async () => {
    const t = await seedTask(workspaceId, { status: 'in_progress' });
    await deliver(t);
    expect(await completeTaskOnBranchMatchMerge(t)).toBe(false);
    expect(await status(t)).toBe('in_progress');
  });

  test('a delivery released to legacy, or the kill switch off, is legacy\'s again', async () => {
    const released = await seedTask(workspaceId, { status: 'in_progress' });
    await deliver(released, 'IN_REVIEW', 'legacy');
    expect(await completeTaskOnBranchMatchMerge(released)).toBe(true);

    const off = await seedWorkspace();
    await q(sql`UPDATE workspaces SET git_config = jsonb_build_object('workflowKernel', false) WHERE id = ${off.workspaceId}::uuid`);
    const t = await seedTask(off.workspaceId, { status: 'in_progress' });
    await q(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, version, repo_full_name, pr_number)
      VALUES (${off.workspaceId}::uuid, ${t}::uuid, 'IN_REVIEW', 1, 'acme/writers', ${prSeq++})`);
    expect(await completeTaskOnBranchMatchMerge(t)).toBe(true);
  });
});

describe('stale failed-task archive', () => {
  test('archives a stale failed task with no delivery, and one whose delivery is terminal', async () => {
    const plain = await seedTask(workspaceId, { status: 'failed' });
    const shipped = await seedTask(workspaceId, { status: 'failed' });
    await deliver(shipped, 'ABANDONED');
    await age(plain); await age(shipped);
    await archiveStaleFailedTasks('30 days');
    expect([await status(plain), await status(shipped)]).toEqual(['cancelled', 'cancelled']);
  });

  test('skips a failed owner whose PR a live delivery still carries', async () => {
    const t = await seedTask(workspaceId, { status: 'failed' });
    await deliver(t, 'IN_REVIEW');
    await age(t);
    await archiveStaleFailedTasks('30 days');
    expect(await status(t)).toBe('failed');
  });
});

describe('dependency failure cascade', () => {
  test('fails a plain dependent, skips a dependent whose PR is in a live delivery', async () => {
    const dep = await seedTask(workspaceId, { status: 'failed', title: 'dep' });
    const plain = await seedTask(workspaceId, { status: 'pending', dependsOn: [dep] });
    const owner = await seedTask(workspaceId, { status: 'in_progress', dependsOn: [dep] });
    await deliver(owner, 'LANDING');
    await cascadeDependencyFailure(dep);
    expect(await status(plain)).toBe('failed');
    expect(await status(owner)).toBe('in_progress');
  });
});

/**
 * S4b (docs/specs/workflow-kernel-library.md §1, AC-1) on real Postgres: the writers of
 * `tasks.status` that INFER where a task's PR went (a merge seen by branch name, a stale-failure
 * archive sweep, a dependency's failure cascading) skip a delivery-owned task, whose lifecycle is
 * the kernel's transitions. A task with no delivery keeps today's writer, byte for byte.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const { completeTaskOnBranchMatchMerge, legacyCompleteTaskOnMerge } = await import('../../src/lib/pr-merged-legacy-task');
const { archiveStaleFailedTasks } = await import('../../src/lib/task-archive');
const { cascadeDependencyFailure } = await import('../../src/lib/task-dependencies');
const { notKernelMergedTaskSql } = await import('../../src/lib/workflow/pr-fact-scope');
const { db } = await import('@buildd/core/db');
const { tasks } = await import('@buildd/core/db/schema');
const { and, eq } = await import('drizzle-orm');

let workspaceId: string;
let prSeq = 200_000 + Math.floor(Math.random() * 700_000);

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

/** A kernel-authority delivery owned by `taskId`, bound to a PR, in `state`. */
async function deliver(taskId: string, state = 'IN_REVIEW', authority = 'kernel'): Promise<number> {
  const n = prSeq++;
  await q(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, version, authority, repo_full_name, pr_number)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, ${state}, 3, ${authority}, 'acme/writers', ${n})`);
  return n;
}
const W = 'acme/writers';
const url = (n: number) => `https://github.com/${W}/pull/${n}`;
const status = async (taskId: string) => (await q<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${taskId}::uuid`))[0].status;
const age = (taskId: string) => q(sql`UPDATE tasks SET updated_at = now() - interval '40 days' WHERE id = ${taskId}::uuid`);

describe('branch-name match on a merged PR', () => {
  test('completes a task with no delivery, as before', async () => {
    const t = await seedTask(workspaceId, { status: 'in_progress' });
    expect(await completeTaskOnBranchMatchMerge(t, { repoFullName: W, prNumber: prSeq++ })).toBe(true);
    expect(await status(t)).toBe('completed');
  });

  test('never completes a delivery-owned task: T17 does', async () => {
    const t = await seedTask(workspaceId, { status: 'in_progress' });
    const n = await deliver(t);
    expect(await completeTaskOnBranchMatchMerge(t, { repoFullName: 'ACME/Writers', prNumber: n })).toBe(false);
    expect(await status(t)).toBe('in_progress');
  });

  test('a delivery released to legacy, or the kill switch off, is legacy\'s again', async () => {
    const released = await seedTask(workspaceId, { status: 'in_progress' });
    const rn = await deliver(released, 'IN_REVIEW', 'legacy');
    expect(await completeTaskOnBranchMatchMerge(released, { repoFullName: W, prNumber: rn })).toBe(true);

    const off = await seedWorkspace();
    await q(sql`UPDATE workspaces SET git_config = jsonb_build_object('workflowKernel', false) WHERE id = ${off.workspaceId}::uuid`);
    const t = await seedTask(off.workspaceId, { status: 'in_progress' });
    const on = prSeq++;
    await q(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, version, repo_full_name, pr_number)
      VALUES (${off.workspaceId}::uuid, ${t}::uuid, 'IN_REVIEW', 1, 'acme/writers', ${on})`);
    expect(await completeTaskOnBranchMatchMerge(t, { repoFullName: W, prNumber: on })).toBe(true);
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

/**
 * S4b review finding 1: an attempt writer (worker PATCH, cleanup, the reaper, recovery hold, CI
 * escalation) carries `notKernelMergedTaskSql()` in its WHERE. Each case is that writer's own
 * statement shape over the real tasks table.
 */
describe('attempt writers cannot move a task the kernel finished (completed, delivery MERGED)', () => {
  const merged = async () => {
    const t = await seedTask(workspaceId, { status: 'completed' });
    await deliver(t, 'MERGED');
    await q(sql`UPDATE tasks SET result = '{"summary":"shipped","prNumber":7}'::jsonb WHERE id = ${t}::uuid`);
    return t;
  };
  const result = async (t: string) => (await q<{ result: Record<string, unknown> }>(sql`SELECT result FROM tasks WHERE id = ${t}::uuid`))[0].result;
  /** The worker PATCH's terminal write, with the route's own guards. */
  const patchTerminal = (t: string, set: Record<string, unknown>) => db.update(tasks).set(set as never)
    .where(and(eq(tasks.id, t), sql`${tasks.status} <> 'cancelled'`, notKernelMergedTaskSql())).returning({ id: tasks.id });

  test('a worker failing after the merge leaves it completed', async () => {
    const t = await merged();
    expect(await patchTerminal(t, { status: 'failed', updatedAt: new Date() })).toEqual([]);
    expect(await status(t)).toBe('completed');
  });

  test('a failure with auto-retry cannot requeue it to pending (it would be built twice)', async () => {
    const t = await merged();
    expect(await patchTerminal(t, { status: 'pending', claimedBy: null, claimedAt: null, updatedAt: new Date() })).toEqual([]);
    expect(await status(t)).toBe('completed');
  });

  test('a stale "no PR found" release check neither fails it nor overwrites its result', async () => {
    const t = await merged();
    await db.update(tasks).set({ status: 'failed', result: { releaseSummary: 'no PR found' } as never, updatedAt: new Date() })
      .where(and(eq(tasks.id, t), notKernelMergedTaskSql()));
    expect(await status(t)).toBe('completed');
    expect(await result(t)).toEqual({ summary: 'shipped', prNumber: 7 });
  });

  test('the reaper\'s plain id writes (silent start, retry cap, unanswered question) and a reactivation do nothing', async () => {
    const t = await merged();
    for (const set of [{ status: 'failed', result: { error: 'reaped' } }, { status: 'assigned' }]) {
      await db.update(tasks).set({ ...set, updatedAt: new Date() } as never).where(and(eq(tasks.id, t), notKernelMergedTaskSql()));
    }
    expect(await status(t)).toBe('completed');
    expect(await result(t)).toEqual({ summary: 'shipped', prNumber: 7 });
  });

  test('everything else moves as before: no delivery, a live delivery, a merged delivery whose task is still open', async () => {
    const plain = await seedTask(workspaceId, { status: 'completed' });
    const live = await seedTask(workspaceId, { status: 'completed' });
    await deliver(live, 'IN_REVIEW');
    const open = await seedTask(workspaceId, { status: 'in_progress' });
    await deliver(open, 'MERGED');
    for (const t of [plain, live, open]) expect((await patchTerminal(t, { status: 'failed', updatedAt: new Date() })).length).toBe(1);
    expect([await status(plain), await status(live), await status(open)]).toEqual(['failed', 'failed', 'failed']);
  });
});

describe('the legacy merge writer (S4b review finding 5, delta finding 2)', () => {
  const task = (id: string, st = 'in_progress') => ({ id, status: st, workspaceId, missionId: null, taskClass: null, release: null, loopState: null });
  const legacy = (n: number, extra: { kernelEffect?: boolean } = {}) =>
    legacyCompleteTaskOnMerge({ repoFullName: W, prUrl: url(n), prNumber: n, runner: 'r', ...extra });

  test('the webhook\'s fallback never completes a task for the PR its delivery owns (T17 does)', async () => {
    const t = await seedTask(workspaceId, { status: 'in_progress' });
    const n = await deliver(t, 'IN_REVIEW');
    expect(await legacy(n)(task(t))).toBe('not_flipped');
    expect(await status(t)).toBe('in_progress');
  });

  test('a stacked series: PR B of a task whose delivery is bound to PR A still completes it on B\'s merge', async () => {
    const t = await seedTask(workspaceId, { status: 'in_progress' });
    await deliver(t, 'MERGED'); // PR A, merged by the kernel; the task stayed open for B
    const b = prSeq++;
    expect(await legacy(b)(task(t))).toBe('flipped');
    expect(await status(t)).toBe('completed');
  });

  test('a follow-up PR B after PR A was abandoned completes the task on B\'s merge', async () => {
    const t = await seedTask(workspaceId, { status: 'in_progress' });
    await deliver(t, 'ABANDONED');
    const b = prSeq++;
    expect(await legacy(b)(task(t))).toBe('flipped');
    // The branch-name match takes the same per-PR view.
    const t2 = await seedTask(workspaceId, { status: 'in_progress' });
    await deliver(t2, 'SUPERSEDED');
    expect(await completeTaskOnBranchMatchMerge(t2, { repoFullName: W, prNumber: prSeq++ })).toBe(true);
  });

  test('a task with no delivery completes as before; an effect queued before S4b still completes its owner', async () => {
    const plain = await seedTask(workspaceId, { status: 'in_progress' });
    expect(await legacy(prSeq++)(task(plain))).toBe('flipped');
    const owned = await seedTask(workspaceId, { status: 'in_progress' });
    const n = await deliver(owned, 'MERGED');
    expect(await legacy(n, { kernelEffect: true })(task(owned))).toBe('flipped');
  });
});

describe('the merge completion runs its one-shot steps once (S4b review finding 2)', () => {
  test('the first claim wins, a retried effect gets false, and the task context keeps what it had', async () => {
    const { claimMergeCompletionOnce } = await import('../../src/lib/pr-merged-work');
    const t = await seedTask(workspaceId, { status: 'completed' });
    await q(sql`UPDATE tasks SET context = '{"keep":1}'::jsonb WHERE id = ${t}::uuid`);
    expect(await claimMergeCompletionOnce(t, 41)).toBe(true);
    expect(await claimMergeCompletionOnce(t, 41)).toBe(false);
    const [row] = await q<{ context: Record<string, any> }>(sql`SELECT context FROM tasks WHERE id = ${t}::uuid`);
    expect(row.context.keep).toBe(1);
    expect(row.context.mergeCompletionAnnounced.prNumber).toBe(41);
  });
});

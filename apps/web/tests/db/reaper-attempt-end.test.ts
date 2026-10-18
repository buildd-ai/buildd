/**
 * AC-1 slice 5 (docs/specs/workflow-kernel-library.md §9): the reaper ends a lost owner attempt
 * through the kernel instead of failing the task itself.
 *
 *  - When the reaper gives up on a kernel delivery's owner task (a retry or infra cap), it writes
 *    the task's result but not its status, and submits AttemptEnded(lost) for the reaped worker;
 *    T4 projects it (`t_attempt`), and `projectOwnerEnd` settles it when no control plane did.
 *  - A late reap (the reaped worker is no longer the task's current attempt: the task was requeued
 *    and claimed again) does nothing: no status, no result, no end in the ledger.
 *  - Placeholder rows no runner executed (external, system, openclaw) are never the attempt: a
 *    newer one does not hide the reaped attempt, and a reaped one ends nothing.
 *
 * Real kernel, real Postgres, stateful fake GitHub, the real reaper.
 */
import { world, type OpenedPr, type World } from './workflow-scenarios-world';
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';

const { resolveTasksOfReapedWorkers } = await import('../../src/lib/stale-workers');

setDefaultTimeout(30_000);

let w: World | undefined;
afterEach(() => w?.dispose());

/** The owner attempt has run for a while and its runner went away; the infra retries are spent. */
async function stalled(pr: OpenedPr): Promise<void> {
  await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '40 minutes',
      context = jsonb_build_object('infraRetryCount', 3) WHERE id = ${pr.ownerTaskId}::uuid`);
  // What the sweep did just before it resolves the task: the worker row is failed.
  await q(sql`UPDATE workers SET status = 'failed', exit_cause = 'infra_failure', error = 'Worker runner went offline (heartbeat expired)',
      created_at = now() - interval '35 minutes', updated_at = now() WHERE id = ${pr.workerId}::uuid`);
}

function reap(pr: OpenedPr, workerId = pr.workerId, runner = 'test') {
  return resolveTasksOfReapedWorkers([{
    id: workerId, taskId: pr.ownerTaskId, prUrl: null, prNumber: null, commitCount: 0, branch: pr.branch,
    error: 'Worker runner went offline (heartbeat expired)', runner,
  }]);
}

const taskRow = async (pr: OpenedPr) =>
  (await q<{ status: string; result: Record<string, unknown> | null }>(sql`SELECT status, result FROM tasks WHERE id = ${pr.ownerTaskId}::uuid`))[0];
const ends = (pr: OpenedPr) =>
  q<{ idempotency_key: string; outcome: string; actor: string }>(sql`SELECT idempotency_key, evidence->>'outcome' AS outcome, actor FROM workflow_transitions
    WHERE delivery_id = ${pr.deliveryId}::uuid AND command = 'AttemptEnded' ORDER BY to_version`);

describe('the reaper ends a lost owner attempt through the kernel', () => {
  test('at the infra cap: AttemptEnded(lost) for the reaped worker, and the kernel\'s projection fails the task', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/reap-lost', files: { 'src/a.ts': 'export const a = 30;\n' } });
    await stalled(pr);
    await reap(pr);
    expect(await ends(pr)).toEqual([{ idempotency_key: `end:${pr.workerId}`, outcome: 'lost', actor: 'sweep:stale-workers' }]);
    expect((await w.delivery(pr)).state).not.toBe('WORKING');
    const t = await taskRow(pr);
    expect(t.status).toBe('failed');
    // The reaper still records why it gave up; only the status is the kernel's.
    expect(t.result).toMatchObject({ errorType: 'infra_stalled', infraRetryCount: 3 });
  });

  test('an owner task classified `review` is still the owner: the kernel hears its lost end and the delivery moves on', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/reap-review-category', files: { 'src/a.ts': 'export const a = 33;\n' } });
    await stalled(pr);
    await q(sql`UPDATE tasks SET category = 'review' WHERE id = ${pr.ownerTaskId}::uuid`);
    await reap(pr);
    expect(await ends(pr)).toEqual([{ idempotency_key: `end:${pr.workerId}`, outcome: 'lost', actor: 'sweep:stale-workers' }]);
    expect((await w.delivery(pr)).state).not.toBe('WORKING');
    const t = await taskRow(pr);
    expect(t.status).toBe('failed');
    expect(t.result).toMatchObject({ errorType: 'infra_stalled' });
  });

  test('a late reap after a re-claim does nothing: the new attempt keeps its task, and the kernel hears no end', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/reap-late', files: { 'src/a.ts': 'export const a = 31;\n' } });
    await stalled(pr);
    // The task was requeued and claimed again; the new attempt's row is newer than the reaped one.
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now(), result = NULL WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
      VALUES (${w.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'w2', 'test', ${pr.branch}, 'running')`);
    // The new worker is live, so the shared rule leaves the task to it. A re-claim still in flight
    // (claimed_at stamped, the new row not inserted yet) is the case the reaper itself must catch.
    await reap(pr);
    expect(await taskRow(pr)).toEqual({ status: 'assigned', result: null });
    expect(await ends(pr)).toEqual([]);

    await q(sql`DELETE FROM workers WHERE task_id = ${pr.ownerTaskId}::uuid AND name = 'w2'`);
    await reap(pr);
    expect(await taskRow(pr)).toEqual({ status: 'assigned', result: null });
    expect(await ends(pr)).toEqual([]);
    expect((await w.delivery(pr)).state).toBe('WORKING');
  });

  test('placeholder rows are not attempts: a newer external row does not hide the reaped attempt, and a reaped system row ends nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/reap-placeholder', files: { 'src/a.ts': 'export const a = 32;\n' } });
    await stalled(pr);
    // A sibling row (a second PR's placeholder) created after the attempt, already settled.
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
      VALUES (${w.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'sibling', 'external', ${pr.branch}, 'completed')`);
    await reap(pr);
    expect(await ends(pr)).toEqual([{ idempotency_key: `end:${pr.workerId}`, outcome: 'lost', actor: 'sweep:stale-workers' }]);
    expect((await taskRow(pr)).status).toBe('failed');

    const other = await w.openPr({ branch: 'feat/reap-system', files: { 'src/b.ts': 'export const b = 32;\n' } });
    await stalled(other);
    // The real attempt is still running; a bookkeeping row the reaper expired is what it reaps.
    await q(sql`UPDATE workers SET status = 'running' WHERE id = ${other.workerId}::uuid`);
    for (const runner of ['system', 'openclaw']) {
      const [ph] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
        VALUES (${w.workspaceId}::uuid, ${other.ownerTaskId}::uuid, ${runner}, ${runner}, ${other.branch}, 'failed') RETURNING id`);
      await q(sql`UPDATE workers SET status = 'failed' WHERE id = ${other.workerId}::uuid`);
      await reap(other, ph.id, runner);
      expect(await taskRow(other)).toMatchObject({ status: 'assigned' });
      expect((await taskRow(other)).result).toBeNull();
      expect(await ends(other)).toEqual([]);
    }
  });
});

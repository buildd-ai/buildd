/**
 * AC-1 slice 2 (docs/specs/workflow-kernel-library.md §9): the kernel reads "the owner attempt
 * ended" from the owner's latest worker row, not from `tasks.status`. Once AttemptEnded becomes
 * the task-status writer, an end that never arrived leaves the task in progress; the floor must
 * still find that end on the worker row and re-send it, or the delivery strands in WORKING.
 *
 * Real kernel, real Postgres, stateful fake GitHub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';
import { world, type World } from './workflow-scenarios-world';

let w: World;
afterEach(() => w?.dispose());

const endCommands = async (deliveryId: string) =>
  (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid AND command = 'AttemptEnded'`))[0].n;

describe('the floor reads the owner attempt end from the worker row', () => {
  test('a task still in progress whose latest worker completed gets its end re-sent', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/end-on-worker', files: { 'src/a.ts': 'export const a = 2;\n' } });
    expect((await w.delivery(pr)).state).toBe('WORKING');
    // The worker finished; the end never reached the kernel, and nothing moved the task.
    await q(sql`UPDATE workers SET status = 'completed' WHERE id = ${pr.workerId}::uuid`);
    expect(await w.taskStatus(pr.ownerTaskId)).toBe('in_progress');

    await w.floor(pr);
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    expect(await endCommands(pr.deliveryId)).toBe(1);
  });

  test('a failed worker of a task in progress is an end too (no retry queued)', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/end-failed', files: { 'src/a.ts': 'export const a = 3;\n' } });
    await q(sql`UPDATE workers SET status = 'failed' WHERE id = ${pr.workerId}::uuid`);
    await w.floor(pr);
    expect((await w.delivery(pr)).state).not.toBe('WORKING');
    expect(await endCommands(pr.deliveryId)).toBe(1);
  });

  test('a queued retry (task pending) is not an end: the delivery waits for the next attempt', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/retry-queued', files: { 'src/a.ts': 'export const a = 4;\n' } });
    await q(sql`UPDATE workers SET status = 'failed' WHERE id = ${pr.workerId}::uuid`);
    await q(sql`UPDATE tasks SET status = 'pending' WHERE id = ${pr.ownerTaskId}::uuid`);
    await w.floor(pr);
    expect((await w.delivery(pr)).state).toBe('WORKING');
    expect(await endCommands(pr.deliveryId)).toBe(0);
  });

  test('a running worker is no end, whatever the task row says', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/still-running', files: { 'src/a.ts': 'export const a = 5;\n' } });
    await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${pr.ownerTaskId}::uuid`);
    await w.floor(pr);
    expect((await w.delivery(pr)).state).toBe('WORKING');
    expect(await endCommands(pr.deliveryId)).toBe(0);
  });

  test('an end the kernel already has is a duplicate: re-running the floor sends nothing new', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/end-twice', files: { 'src/a.ts': 'export const a = 6;\n' } });
    await w.handOn(pr);
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    await w.floor(pr);
    expect(await endCommands(pr.deliveryId)).toBe(1);
  });
});

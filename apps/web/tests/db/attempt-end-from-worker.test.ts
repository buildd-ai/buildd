/**
 * AC-1 slice 2 (docs/specs/workflow-kernel-library.md §9): the kernel reads "the owner attempt
 * ended" from the owner's latest worker row, not from `tasks.status`. A running owner task holds
 * `assigned` for its whole attempt (nothing writes `in_progress` any more), so a task left
 * `assigned` whose worker finished is the end the floor must find and re-send, or the delivery
 * strands in WORKING once AttemptEnded becomes the task-status writer.
 *
 * Every owner here is `assigned` with a `claimed_at`, as the claim leaves it. Real kernel, real
 * Postgres, stateful fake GitHub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';
import { world, type OpenedPr, type World } from './workflow-scenarios-world';

const { OWNER_END_SETTLE_MS } = await import('../../src/lib/workflow/task-projection');

let w: World;
afterEach(() => w?.dispose());

const endCommands = async (deliveryId: string) =>
  (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid AND command = 'AttemptEnded'`))[0].n;

/** Minutes past the settle window. */
const settled = Math.ceil(OWNER_END_SETTLE_MS / 60_000) + 1;
const minutesAgo = (m: number) => sql`now() - make_interval(mins => ${m}::int)`;

/** The owner as a claim leaves it: `assigned`, claimed `claimedMin` minutes ago. */
async function claimed(pr: OpenedPr, claimedMin: number): Promise<void> {
  await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = ${minutesAgo(claimedMin)} WHERE id = ${pr.ownerTaskId}::uuid`);
}
/** The owner's worker ends: `status`, created `createdMin` and last written `changedMin` minutes ago. */
async function workerEnds(pr: OpenedPr, status: string, o: { createdMin: number; changedMin: number }): Promise<void> {
  await q(sql`UPDATE workers SET status = ${status}, created_at = ${minutesAgo(o.createdMin)}, updated_at = ${minutesAgo(o.changedMin)}
    WHERE id = ${pr.workerId}::uuid`);
}

describe('the floor reads the owner attempt end from the worker row (task assigned)', () => {
  test('the worker of this claim completed: its end is re-sent and the delivery leaves WORKING', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/end-on-worker', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await claimed(pr, settled + 10);
    expect((await w.delivery(pr)).state).toBe('WORKING');
    // The worker finished after the claim; the end never reached the kernel, and nothing moved the task.
    await workerEnds(pr, 'completed', { createdMin: settled + 5, changedMin: settled });
    expect(await w.taskStatus(pr.ownerTaskId)).toBe('assigned');

    await w.floor(pr);
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    expect(await endCommands(pr.deliveryId)).toBe(1);
  });

  test('the worker of this claim failed: its end is re-sent', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/end-failed', files: { 'src/a.ts': 'export const a = 3;\n' } });
    await claimed(pr, settled + 10);
    await workerEnds(pr, 'failed', { createdMin: settled + 5, changedMin: settled });
    await w.floor(pr);
    expect((await w.delivery(pr)).state).not.toBe('WORKING');
    expect(await endCommands(pr.deliveryId)).toBe(1);
  });

  test('claimed_at newer than the latest worker: a claim whose new worker row is not inserted yet sends no end', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/claim-in-flight', files: { 'src/a.ts': 'export const a = 4;\n' } });
    // The previous attempt's worker failed long ago; a new claim stamped claimed_at just now.
    await workerEnds(pr, 'failed', { createdMin: settled + 30, changedMin: settled + 20 });
    await claimed(pr, 0);
    await w.floor(pr);
    expect((await w.delivery(pr)).state).toBe('WORKING');
    expect(await endCommands(pr.deliveryId)).toBe(0);
  });

  test('PATCH race: the worker status is written before the retry requeue; an end read in between is not sent', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/patch-race', files: { 'src/a.ts': 'export const a = 5;\n' } });
    await claimed(pr, settled + 10);
    // workers/[id] PATCH: the terminal worker status is reserved in its own statement...
    await workerEnds(pr, 'failed', { createdMin: settled + 5, changedMin: 0 });
    // ...a floor pass (or a late PR open) lands before the PATCH decides on the auto-retry.
    await w.floor(pr);
    expect((await w.delivery(pr)).state).toBe('WORKING');
    expect(await endCommands(pr.deliveryId)).toBe(0);
    // The PATCH then queues the retry (back to pending): a requeue, never an attempt end.
    await q(sql`UPDATE tasks SET status = 'pending', claimed_at = NULL WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`UPDATE workers SET updated_at = ${minutesAgo(settled)} WHERE id = ${pr.workerId}::uuid`);
    await w.floor(pr);
    expect((await w.delivery(pr)).state).toBe('WORKING');
    expect(await endCommands(pr.deliveryId)).toBe(0);
  });

  test('a running worker is no end, whatever the task row says', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/still-running', files: { 'src/a.ts': 'export const a = 6;\n' } });
    await claimed(pr, settled + 10);
    await q(sql`UPDATE workers SET created_at = ${minutesAgo(settled + 5)}, updated_at = ${minutesAgo(settled)} WHERE id = ${pr.workerId}::uuid`);
    await w.floor(pr);
    await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${pr.ownerTaskId}::uuid`);
    await w.floor(pr);
    expect((await w.delivery(pr)).state).toBe('WORKING');
    expect(await endCommands(pr.deliveryId)).toBe(0);
  });

  test('an end the kernel already has is a duplicate: re-running the floor sends nothing new', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/end-twice', files: { 'src/a.ts': 'export const a = 7;\n' } });
    await claimed(pr, settled + 10);
    await w.handOn(pr);
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    await workerEnds(pr, 'completed', { createdMin: settled + 5, changedMin: settled });
    await w.floor(pr);
    expect(await endCommands(pr.deliveryId)).toBe(1);
  });
});

/**
 * AC-13 (docs/specs/workflow-kernel-library.md §4) on real Postgres: a PR with
 * no delivery is adopted (open_delivery) before a worker door merges it, then
 * lands only through the kernel's gate. The resolver read that tells "no
 * delivery" from "released to legacy" is the real SQL; GitHub is the stateful
 * fake. Nothing here reaches a legacy merge call.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { seam, world, type OpenedPr, type World } from './workflow-scenarios-world';
import { q, seedTask } from './harness';

const { adoptBeforeMerge } = await import('../../src/lib/workflow/merge-adoption');

const SYSTEM = { principal: { kind: 'system' as const, id: 'system:auto_merge' } };

let w: World;
afterEach(() => w?.dispose());

/** A PR buildd's worker opened that the kernel never saw: no owner registered, so the open webhook opens nothing. */
async function undeliveredPr(w: World, o: { ownerStatus?: string; workerStatus?: string } = {}) {
  const branch = `feat/adopt-${Math.random().toString(36).slice(2, 8)}`;
  const ownerTaskId = await seedTask(w.workspaceId, { status: o.ownerStatus ?? 'completed', title: `feat: ${branch}` });
  w.gh.createBranch(w.repo, branch, 'dev');
  const head = w.gh.push(w.repo, branch, { 'src/a.ts': 'export const a = 2;\n' }, { message: branch });
  const prNumber = w.gh.openPr(w.repo, { head: branch, base: 'dev', title: `feat: ${branch}` });
  const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, commit_count)
    VALUES (${w.workspaceId}::uuid, ${ownerTaskId}::uuid, 'w', 'test', ${branch}, ${o.workerStatus ?? 'completed'}, ${head}, ${prNumber}, ${`https://github.com/${w.repo}/pull/${prNumber}`}, 1) RETURNING id`);
  await w.deliver();
  expect(await seam.kernelDeliveryOfPr({ workspaceId: w.workspaceId, prNumber })).toBeNull();
  return { branch, head, prNumber, ownerTaskId, workerId: wk.id };
}

const input = (w: World, prNumber: number, taskId: string | null) => ({
  workspaceId: w.workspaceId, installationId: w.installationId, repoFullName: w.repo, prNumber, taskId, door: 'auto_merge',
});

describe('a PR with no delivery is adopted before a door merges it (AC-13)', () => {
  test('adopted with its task as owner; refused at T15 until a kernel review approves its head; then it lands', async () => {
    w = await world();
    const p = await undeliveredPr(w);
    const a = await adoptBeforeMerge(input(w, p.prNumber, p.ownerTaskId), SYSTEM);
    expect(a).toMatchObject({ kind: 'kernel', adopted: true });
    const deliveryId = (a as { deliveryId: string }).deliveryId;
    const pr: OpenedPr = { prNumber: p.prNumber, branch: p.branch, base: 'dev', ownerTaskId: p.ownerTaskId, workerId: p.workerId, deliveryId, head: p.head };

    // The owner had already finished: its end is forwarded and a review of the live head is owed.
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    expect((await w.delivery(pr)).currentHeadSha).toBe(p.head);

    const early = await w.land(pr, p.head);
    expect(early).toMatchObject({ merged: false, outcome: 'rejected', reason: 'state_not_allowed' });
    expect(w.mergeCalls(pr)).toHaveLength(0);

    // A second door asking again adopts nothing new: the delivery is the PR's.
    expect(await adoptBeforeMerge(input(w, p.prNumber, p.ownerTaskId), SYSTEM)).toEqual({ kind: 'kernel', deliveryId, adopted: false });

    await w.approve(pr, p.head);
    const landed = await w.land(pr, p.head);
    expect(landed).toMatchObject({ merged: true });
    expect(w.mergeCalls(pr).length).toBeGreaterThan(0);
  }, 90_000);

  test('the kill switch off: the legacy answer, and no delivery is written', async () => {
    w = await world({ gitConfig: { workflowKernel: false } });
    const p = await undeliveredPr(w);
    expect(await adoptBeforeMerge(input(w, p.prNumber, p.ownerTaskId), SYSTEM)).toEqual({ kind: 'legacy', reason: 'kernel_off' });
    const rows = await q(sql`SELECT id FROM workflow_deliveries WHERE workspace_id = ${w.workspaceId}::uuid AND pr_number = ${p.prNumber}::int`);
    expect(rows).toHaveLength(0);
  }, 60_000);

  test('a delivery released to legacy stays legacy (the sticky release)', async () => {
    w = await world();
    const p = await undeliveredPr(w);
    const a = await adoptBeforeMerge(input(w, p.prNumber, p.ownerTaskId), SYSTEM);
    expect(a.kind).toBe('kernel');
    await q(sql`UPDATE workflow_deliveries SET authority = 'legacy', released_at = now() WHERE id = ${(a as { deliveryId: string }).deliveryId}::uuid`);
    expect(await adoptBeforeMerge(input(w, p.prNumber, p.ownerTaskId), SYSTEM)).toEqual({ kind: 'legacy', reason: 'released' });
  }, 60_000);

  test('a review task cannot own a delivery: refused, nothing written, nothing merged', async () => {
    w = await world();
    const p = await undeliveredPr(w);
    const reviewTask = await seedTask(w.workspaceId, { status: 'completed', title: 'review' });
    await q(sql`UPDATE tasks SET category = 'review' WHERE id = ${reviewTask}::uuid`);
    const a = await adoptBeforeMerge(input(w, p.prNumber, reviewTask), SYSTEM);
    expect(a).toMatchObject({ kind: 'refused', reason: 'adoption_failed:review_task' });
    expect(await seam.kernelDeliveryOfPr({ workspaceId: w.workspaceId, prNumber: p.prNumber })).toBeNull();
  }, 60_000);

  test('no task at all: refused', async () => {
    w = await world();
    const p = await undeliveredPr(w);
    expect(await adoptBeforeMerge(input(w, p.prNumber, null), SYSTEM)).toMatchObject({ kind: 'refused', reason: 'adoption_failed:no_owner_task' });
  }, 60_000);
});

/**
 * AC-1 slice 6 (docs/specs/workflow-kernel-library.md §9): an attempt's task goes back to the queue
 * through the kernel (AttemptRequeued), never through its writer's own status write.
 *
 *  - The transition records the requeue (`requeue:<workerId>`) and moves the task to `pending` in
 *    its own statement (`t_requeue`), reading the delivery CTE, so a version miss writes nothing.
 *  - Only an open task, only while the requeuing worker is its current attempt: a requeue that
 *    lands late, after the task was claimed again, moves nothing (applied, stale or re-sent).
 *  - Each requeue path: the worker PATCH's retry, loop hold, codex deferral and sandbox mount gap,
 *    and the conflict-fix recovery of a kernel repair.
 *
 * Real kernel, real Postgres, stateful fake GitHub, the real worker route with API-key auth.
 */
import { seam, world, type OpenedPr, type World } from './workflow-scenarios-world';
import { afterEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { q } from './harness';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

const workersRoute = await import('../../src/app/api/workers/[id]/route');
const { transitionSql } = await import('../../src/lib/workflow/kernel');
const { recoverStalledConflictFix } = await import('../../src/lib/conflict-retry');

setDefaultTimeout(30_000);

let w: World | undefined;
afterEach(() => w?.dispose());

type TaskRow = { status: string; claimed_at: string | null; claimed_by: string | null; context: Record<string, unknown> | null; start_at: string | null };
const taskRow = async (id: string) => (await q<TaskRow>(sql`SELECT status, claimed_at, claimed_by, context, start_at FROM tasks WHERE id = ${id}::uuid`))[0];
const status = (pr: OpenedPr) => w!.taskStatus(pr.ownerTaskId);
/** The owner task as a runner holds it while its attempt runs. */
const assigned = (pr: OpenedPr) => q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '5 minutes' WHERE id = ${pr.ownerTaskId}::uuid`);
const requeues = async (pr: OpenedPr) =>
  (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM workflow_transitions WHERE delivery_id = ${pr.deliveryId}::uuid AND command = 'AttemptRequeued'`))[0].n;

function requeue(pr: OpenedPr, o: { workerId?: string; reason?: string } = {}) {
  return seam.attemptRequeued({
    task: { id: pr.ownerTaskId, workspaceId: w!.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null },
    workerId: o.workerId ?? pr.workerId,
    reason: o.reason ?? 'retry',
    source: 'runner',
  });
}

/** The requeue (or anything) already put the task back; a runner claimed it again with a new worker row. */
async function reclaimed(pr: OpenedPr, o: { newWorker: boolean }): Promise<void> {
  await q(sql`UPDATE workers SET status = 'failed', created_at = now() - interval '10 minutes' WHERE id = ${pr.workerId}::uuid`);
  await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() WHERE id = ${pr.ownerTaskId}::uuid`);
  if (o.newWorker) {
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
      VALUES (${w!.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'w2', 'test', ${pr.branch}, 'running')`);
  }
}

describe('AttemptRequeued moves the owner task back to the queue in its own statement', () => {
  test('while WORKING: applied in place, the task is pending with its claim released, the delivery does not move', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rq-working', files: { 'src/a.ts': 'export const a = 1;\n' } });
    await assigned(pr);
    const r = await requeue(pr);
    expect(r).toMatchObject({ handled: true, requeued: true, result: { result: 'applied' } });
    expect((await w.delivery(pr)).state).toBe('WORKING');
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedAt: t.claimed_at, claimedBy: t.claimed_by }).toEqual({ status: 'pending', claimedAt: null, claimedBy: null });
    expect(await requeues(pr)).toBe(1);
  });

  test('a re-sent requeue (a parked re-submit) is a duplicate: one transition, the task stays pending', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rq-dup', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await assigned(pr);
    await requeue(pr);
    const again = await requeue(pr, { reason: 'loop_hold' });
    expect(again.result?.result).toBe('duplicate');
    expect(again.requeued).toBe(true);
    expect(await requeues(pr)).toBe(1);
    expect(await status(pr)).toBe('pending');
  });

  test('a version miss writes nothing: the projection reads the delivery CTE', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rq-cas', files: { 'src/a.ts': 'export const a = 3;\n' } });
    await assigned(pr);
    const d = await w.delivery(pr);
    const decision = {
      result: 'apply' as const, command: 'AttemptRequeued' as const, idempotencyKey: `requeue:${pr.workerId}`, fromState: 'WORKING' as const, toState: 'WORKING' as const,
      patch: {}, rounds: [], attempts: [], effects: [], evidence: { requeue: true, reason: 'retry', workerId: pr.workerId, taskId: pr.ownerTaskId },
    };
    expect(await q(transitionSql({ ...decision, guard: { version: d.version + 7, states: ['WORKING'] } }, { deliveryId: pr.deliveryId }))).toEqual([]);
    expect(await status(pr)).toBe('assigned');
    // The same decision at the version it read: the statement itself moves the task.
    expect((await q(transitionSql({ ...decision, guard: { version: d.version, states: ['WORKING'] } }, { deliveryId: pr.deliveryId }))).length).toBe(1);
    expect(await status(pr)).toBe('pending');
  });

  test('out of order: a requeue that lands after the task was claimed again moves nothing, WORKING or not', async () => {
    w = await world();
    // Still WORKING: the reducer records it, the statement's guard keeps the new attempt.
    const a = await w.openPr({ branch: 'feat/rq-late-working', files: { 'src/a.ts': 'export const a = 4;\n' } });
    await reclaimed(a, { newWorker: true });
    const ra = await requeue(a);
    expect(ra.result?.result).toBe('applied');
    expect(ra.requeued).toBe(false);
    expect(await status(a)).toBe('assigned');

    // Moved on (the next attempt handed the head on): not bound, and the fallback's guard holds too.
    const b = await w.openPr({ branch: 'feat/rq-late-moved', files: { 'src/b.ts': 'export const b = 4;\n' } });
    await w.handOn(b);
    expect((await w.delivery(b)).state).toBe('AWAITING_REVIEW');
    await reclaimed(b, { newWorker: true });
    const rb = await requeue(b);
    expect(rb.result).toMatchObject({ result: 'stale', reason: 'attempt_not_bound' });
    expect(await status(b)).toBe('assigned');

    // A re-claim in flight (claimed_at stamped, the new worker row not inserted yet).
    const c = await w.openPr({ branch: 'feat/rq-late-inflight', files: { 'src/c.ts': 'export const c = 4;\n' } });
    await reclaimed(c, { newWorker: false });
    await requeue(c);
    expect(await status(c)).toBe('assigned');
  });

  test('past WORKING with the current attempt (a loop task\'s next iteration): not bound, still requeued by the guarded projection', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rq-next-iteration', files: { 'src/a.ts': 'export const a = 5;\n' } });
    await w.handOn(pr);
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '1 minute' WHERE id = ${pr.ownerTaskId}::uuid`);
    const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
      VALUES (${w.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'w2', 'test', ${pr.branch}, 'completed') RETURNING id`);
    const r = await requeue(pr, { workerId: wk.id, reason: 'loop_hold' });
    expect(r.result).toMatchObject({ result: 'stale', reason: 'attempt_not_bound' });
    expect(r.requeued).toBe(true);
    expect(await status(pr)).toBe('pending');
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
  });

  test('a settled task keeps its status: cancelled, failed, and a completion whose delivery merged', async () => {
    w = await world();
    for (const settled of ['cancelled', 'failed'] as const) {
      const pr = await w.openPr({ branch: `feat/rq-${settled}`, files: { 'src/a.ts': `export const a = '${settled}';\n` } });
      await q(sql`UPDATE tasks SET status = ${settled} WHERE id = ${pr.ownerTaskId}::uuid`);
      expect((await requeue(pr)).requeued).toBe(false);
      expect(await status(pr)).toBe(settled);
    }
    const merged = await w.openPr({ branch: 'feat/rq-merged', files: { 'src/c.ts': 'export const c = 6;\n' } });
    await w.approve(merged);
    await w.land(merged, merged.head);
    expect((await w.delivery(merged)).state).toBe('MERGED');
    expect(await status(merged)).toBe('completed');
    // A late requeue of a shipped task: refused by the kernel (terminal), and the projection keeps it completed.
    const late = await requeue(merged);
    expect(late.result).toMatchObject({ result: 'stale', reason: 'attempt_not_bound' });
    expect(late.requeued).toBe(false);
    expect(await status(merged)).toBe('completed');
  });

  test('a task that is not the delivery\'s owner is never moved', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rq-not-owner', files: { 'src/a.ts': 'export const a = 7;\n' } });
    const other = await w.openPr({ branch: 'feat/rq-other', files: { 'src/b.ts': 'export const b = 7;\n' } });
    await assigned(other);
    expect(await seam.projectRequeue({ deliveryId: pr.deliveryId, taskId: other.ownerTaskId, workerId: other.workerId })).toBe(false);
    expect(await status(other)).toBe('assigned');
  });
});

// ── The worker PATCH family ──────────────────────────────────────────────────

async function serviceKey(teamId: string): Promise<{ id: string; key: string }> {
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hashed = createHash('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${hashed}, ${teamId}::uuid, 'worker', 10) RETURNING id`);
  return { id: a.id, key };
}

async function patchWorker(pr: OpenedPr, body: Record<string, unknown>) {
  const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w!.workspaceId}::uuid`);
  const account = await serviceKey(ws.team_id);
  await q(sql`UPDATE workers SET account_id = ${account.id}::uuid WHERE id = ${pr.workerId}::uuid`);
  await q(sql`UPDATE tasks SET output_requirement = 'none' WHERE id = ${pr.ownerTaskId}::uuid`);
  return workersRoute.PATCH(
    new NextRequest(`http://localhost/api/workers/${pr.workerId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: pr.workerId }) } as never,
  );
}

async function inMission(pr: OpenedPr): Promise<void> {
  const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w!.workspaceId}::uuid`);
  const [m] = await q<{ id: string }>(sql`INSERT INTO missions (team_id, workspace_id, title) VALUES (${ws.team_id}::uuid, ${w!.workspaceId}::uuid, 'requeue mission') RETURNING id`);
  await q(sql`UPDATE tasks SET mission_id = ${m.id}::uuid WHERE id = ${pr.ownerTaskId}::uuid`);
}

describe('the worker PATCH requeues a kernel owner through AttemptRequeued', () => {
  test('retry: a failed mission attempt with its retry left: pending through the kernel, the retry counted, the claim released', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rq-patch-retry', files: { 'src/a.ts': 'export const a = 10;\n' } });
    await inMission(pr);
    await assigned(pr);
    const res = await patchWorker(pr, { status: 'failed', error: 'tests are red' });
    expect(res.status).toBe(200);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedAt: t.claimed_at, retryCount: t.context?.retryCount }).toEqual({ status: 'pending', claimedAt: null, retryCount: 1 });
    expect(await requeues(pr)).toBe(1);
  });

  test('loop hold: a completed attempt whose checks have not reported: pending through the kernel, and its end still hands the head on', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rq-patch-hold', files: { 'src/a.ts': 'export const a = 11;\n' } });
    await q(sql`UPDATE tasks SET loop_config = ${JSON.stringify({ exitCondition: { type: 'pr_checks_green' }, maxLoops: 3, waitExpiryMinutes: 240 })}::jsonb WHERE id = ${pr.ownerTaskId}::uuid`);
    await assigned(pr);
    const res = await patchWorker(pr, { status: 'completed', summary: 'pushed, waiting on CI', commitCount: 1, lastCommitSha: pr.head });
    expect(res.status).toBe(200);
    const t = await taskRow(pr.ownerTaskId);
    expect(t.status).toBe('pending');
    expect(t.context?.loopWebhookWait).toBeDefined();
    expect(t.start_at).not.toBeNull();
    expect(await w.commands(pr)).toEqual(expect.arrayContaining(['AttemptRequeued', 'AttemptEnded']));
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
  });

  test('codex deferral: pending through the kernel', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rq-patch-deferral', files: { 'src/a.ts': 'export const a = 12;\n' } });
    await assigned(pr);
    const res = await patchWorker(pr, { status: 'failed', error: 'Deferred: codex is not available on this runner' });
    expect(res.status).toBe(200);
    expect(await status(pr)).toBe('pending');
    expect(await requeues(pr)).toBe(1);
    expect((await w.delivery(pr)).state).toBe('WORKING');
  });

  test('sandbox mount gap: pending through the kernel, and the fields it carries land too', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rq-patch-mount', files: { 'src/a.ts': 'export const a = 13;\n' } });
    await assigned(pr);
    const res = await patchWorker(pr, { status: 'failed', error: 'bwrap: missing path', sandboxMountGap: true });
    expect(res.status).toBe(200);
    expect(await status(pr)).toBe('pending');
    expect(await requeues(pr)).toBe(1);
  });

  test('a delivery the kill switch released: the PATCH still requeues the task (the route\'s own projection), with no transition', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rq-patch-released', files: { 'src/a.ts': 'export const a = 14;\n' } });
    await assigned(pr);
    await q(sql`UPDATE workflow_deliveries SET authority = 'legacy' WHERE id = ${pr.deliveryId}::uuid`);
    const res = await patchWorker(pr, { status: 'failed', error: 'Deferred: codex is not available on this runner' });
    expect(res.status).toBe(200);
    expect(await status(pr)).toBe('pending');
    expect(await requeues(pr)).toBe(0);
  });
});

// ── The conflict-fix recovery ────────────────────────────────────────────────

describe('a stalled kernel repair is requeued through AttemptRequeued', () => {
  async function stalledRepair(pr: OpenedPr) {
    await w!.approve(pr);
    w!.gh.setCheck(w!.repo, pr.head, 'build', { conclusion: 'failure' });
    const seen = await seam.observeCiFailure({ workspaceId: w!.workspaceId, repoFullName: w!.repo, prNumber: pr.prNumber, installationId: w!.installationId, headSha: pr.head, signature: 'ci_failed', maxAttempts: 3, source: 'webhook:check_suite' });
    expect(seen).toMatchObject({ handled: true, result: { result: 'applied' } });
    const fixId = (seen as { attemptTaskId: string }).attemptTaskId;
    const [fix] = await q<{ id: string; workspace_id: string; delivery_id: string; delivery_role: string; context: Record<string, unknown> }>(sql`SELECT id, workspace_id, delivery_id, delivery_role, context FROM tasks WHERE id = ${fixId}::uuid`);
    const task = { id: fix.id, workspaceId: fix.workspace_id, deliveryId: fix.delivery_id, deliveryRole: fix.delivery_role, context: fix.context };
    expect(await seam.claimFix(task)).toEqual({ action: 'proceed' });
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '30 minutes' WHERE id = ${fix.id}::uuid`);
    const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, created_at, updated_at)
      VALUES (${w!.workspaceId}::uuid, ${fix.id}::uuid, 'fix', 'test', ${pr.branch}, 'failed', now() - interval '25 minutes', now() - interval '20 minutes') RETURNING id`);
    const row = (await q<{ id: string; status: string; created_at: string; claimed_at: string; updated_at: string; context: unknown }>(sql`SELECT id, status, created_at, claimed_at, updated_at, context FROM tasks WHERE id = ${fix.id}::uuid`))[0];
    return { task, workerId: wk.id, row: { id: row.id, status: row.status, createdAt: row.created_at, claimedAt: row.claimed_at, updatedAt: row.updated_at, context: row.context } };
  }

  test('its worker ended without a fix: the recovery requeues it through the kernel, bound to the open ledger row', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rq-repair', files: { 'src/a.ts': 'export const a = 20;\n' } });
    const s = await stalledRepair(pr);
    expect(await recoverStalledConflictFix(s.row)).toEqual({ stalled: true, action: 'repair' });
    const t = await taskRow(s.task.id);
    expect({ status: t.status, claimedAt: t.claimed_at }).toEqual({ status: 'pending', claimedAt: null });
    expect((t.context?.conflictRecovery as { action?: string } | undefined)?.action).toBe('repair');
    expect(await w.commands(pr)).toContain('AttemptRequeued');
    expect((await w.delivery(pr)).state).toBe('REPAIRING');
  });

  test('a repair the delivery is no longer bound to (its ledger row ended) is not requeued', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/rq-repair-ended', files: { 'src/a.ts': 'export const a = 21;\n' } });
    const s = await stalledRepair(pr);
    await q(sql`UPDATE workflow_attempts SET status = 'ended' WHERE id = ${String(s.task.context.workflowAttemptId)}::uuid`);
    expect(await recoverStalledConflictFix(s.row)).toEqual({ stalled: true, action: 'none' });
    expect(await w.taskStatus(s.task.id)).toBe('assigned');
  });
});

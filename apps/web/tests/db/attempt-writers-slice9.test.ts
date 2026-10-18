/**
 * AC-1 slice 9 (docs/specs/workflow-kernel-library.md §9): the last attempt statements that set a
 * kernel owner task's status themselves go through the kernel.
 *
 *  - A settled owner task opened again is AttemptReopened: the recovery doors' requeue of a failed
 *    task (`pending`) and a resumed worker (`assigned`), each naming the end it reopens.
 *  - A claim that runs no attempt is AttemptWithdrawn: the claim route's rollback of its own claim,
 *    a claim the cleanup finds with no attempt row, and a queued task refused for good (a workspace
 *    that lacks the task's project, a mount gap that ran its mission out of budget).
 *  - The cleanup route's requeue, retry-cap failure and completed-worker promotion are the current
 *    attempt's AttemptRequeued / AttemptEnded; the reaper's question superseded by recovery is the
 *    attempt's end; the PATCH's contract or loop failure override and a failed release are its end.
 *  - A loop's exit leaves a task with another open PR open (T17's rule).
 *
 * Every path is checked late (after the task was claimed again) and twice (a re-send).
 * Real kernel, real Postgres, stateful fake GitHub, the real routes and sweeps.
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
const cleanupRoute = await import('../../src/app/api/tasks/cleanup/route');
const { requeueFailedTasks } = await import('../../src/lib/credential-recovery');
const { cleanupStuckWaitingInput } = await import('../../src/lib/stale-workers');
const { evaluateAndAdvanceLoopOnCiGreen } = await import('../../src/lib/loop-webhook');
const { reopenOwner, withdrawOwner } = await import('../../src/lib/workflow/owner-attempt');
const { systemPrincipal } = await import('../../src/lib/workflow/kernel-client');

setDefaultTimeout(30_000);

let w: World | undefined;
afterEach(() => {
  w?.dispose();
});

type TaskRow = { status: string; claimed_at: string | null; claimed_by: string | null; context: Record<string, unknown> | null; result: Record<string, unknown> | null; loop_state: string | null };
const taskRow = async (id: string) =>
  (await q<TaskRow>(sql`SELECT status, claimed_at::text AS claimed_at, claimed_by::text AS claimed_by, context, result, loop_state FROM tasks WHERE id = ${id}::uuid`))[0];
const status = (pr: OpenedPr) => w!.taskStatus(pr.ownerTaskId);
const transitions = (pr: OpenedPr, command: string) =>
  q<{ idempotency_key: string; evidence: Record<string, unknown> }>(sql`SELECT idempotency_key, evidence FROM workflow_transitions
    WHERE delivery_id = ${pr.deliveryId}::uuid AND command = ${command} ORDER BY to_version`);
const ownerTask = (pr: OpenedPr) => ({ id: pr.ownerTaskId, workspaceId: w!.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null });
const principal = systemPrincipal('system:test');

/** The owner's attempt failed and its task with it, the delivery still WORKING (no end applied). */
async function failed(pr: OpenedPr, workerId = pr.workerId): Promise<string> {
  const [r] = await q<{ completed_at: string }>(sql`UPDATE workers SET status = 'failed', error = 'auth expired', completed_at = now() - interval '1 minute'
    WHERE id = ${workerId}::uuid RETURNING completed_at::text`);
  await q(sql`UPDATE tasks SET status = 'failed', claimed_at = now() - interval '20 minutes', claimed_by = NULL WHERE id = ${pr.ownerTaskId}::uuid`);
  return new Date(r.completed_at).toISOString();
}

/** A runner claimed the task again: its new attempt row is newer than every earlier one. */
async function reclaim(pr: OpenedPr, o: { workerStatus?: string; taskStatus?: string } = {}): Promise<string> {
  await q(sql`UPDATE workers SET created_at = now() - interval '30 minutes' WHERE task_id = ${pr.ownerTaskId}::uuid`);
  await q(sql`UPDATE tasks SET status = ${o.taskStatus ?? 'assigned'}, claimed_at = now() - interval '1 minute' WHERE id = ${pr.ownerTaskId}::uuid`);
  const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
    VALUES (${w!.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'next', 'test', ${pr.branch}, ${o.workerStatus ?? 'running'}) RETURNING id`);
  return wk.id;
}

async function apiKey(level: 'worker' | 'admin'): Promise<{ id: string; key: string }> {
  const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w!.workspaceId}::uuid`);
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hashed = createHash('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${hashed}, ${ws.team_id}::uuid, ${level}, 10) RETURNING id`);
  return { id: a.id, key };
}

async function patchWorker(pr: OpenedPr, workerId: string, body: Record<string, unknown>) {
  const account = await apiKey('worker');
  await q(sql`UPDATE workers SET account_id = ${account.id}::uuid WHERE id = ${workerId}::uuid`);
  await q(sql`UPDATE tasks SET output_requirement = 'none' WHERE id = ${pr.ownerTaskId}::uuid`);
  return workersRoute.PATCH(
    new NextRequest(`http://localhost/api/workers/${workerId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: workerId }) } as never,
  );
}

async function cleanup(accountId: string, key: string) {
  void accountId;
  return cleanupRoute.POST(new NextRequest('http://localhost/api/tasks/cleanup', { method: 'POST', headers: { authorization: `Bearer ${key}` } }) as never);
}

// ── AttemptReopened: the recovery doors ──────────────────────────────────────

describe('a recovery door reopens a failed owner task through the kernel (AttemptReopened, pending)', () => {
  test('the failed attempt is reopened in the WORKING transition, named by its worker and its end; a re-send is a duplicate', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/reopen', files: { 'src/a.ts': 'export const a = 90;\n' } });
    const endedAt = await failed(pr);
    expect(await requeueFailedTasks([pr.ownerTaskId], 'credential.restored')).toEqual([pr.ownerTaskId]);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedAt: t.claimed_at }).toEqual({ status: 'pending', claimedAt: null });
    expect((await transitions(pr, 'AttemptReopened')).map((x) => x.idempotency_key)).toEqual([`reopen:${pr.ownerTaskId}:${pr.workerId}:${endedAt}`]);
    // Twice: the task is no longer failed, so nothing moves and nothing more is recorded.
    expect(await requeueFailedTasks([pr.ownerTaskId], 'credential.restored')).toEqual([]);
    expect(await status(pr)).toBe('pending');
    expect((await transitions(pr, 'AttemptReopened')).length).toBe(1);
  });

  test('late, after the task was claimed again and that attempt failed too: a reopen naming the older end moves nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/reopen-late', files: { 'src/a.ts': 'export const a = 91;\n' } });
    const oldEnd = await failed(pr);
    const next = await reclaim(pr);
    await failed(pr, next);
    const r = await reopenOwner({ task: ownerTask(pr), workerId: pr.workerId, endedAt: oldEnd, to: 'pending', reason: 'credential_restored', source: 'test', principal });
    expect(r).toBe(false);
    expect(await status(pr)).toBe('failed');
    // The recovery itself names the latest attempt, so it reopens the task.
    expect(await requeueFailedTasks([pr.ownerTaskId], 'task.requeued')).toEqual([pr.ownerTaskId]);
    expect(await status(pr)).toBe('pending');
  });

  test('a task with no delivery keeps the legacy write; a delivery the kill switch released is still reopened under the guard', async () => {
    w = await world();
    const [plain] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status) VALUES (${w.workspaceId}::uuid, 'plain', 'failed') RETURNING id`);
    const pr = await w.openPr({ branch: 'feat/reopen-legacy', files: { 'src/a.ts': 'export const a = 92;\n' } });
    await failed(pr);
    await q(sql`UPDATE workflow_deliveries SET authority = 'legacy' WHERE id = ${pr.deliveryId}::uuid`);
    expect((await requeueFailedTasks([plain.id, pr.ownerTaskId], 'credential.restored')).sort()).toEqual([plain.id, pr.ownerTaskId].sort());
    expect(await w.taskStatus(plain.id)).toBe('pending');
    expect(await status(pr)).toBe('pending');
    expect((await transitions(pr, 'AttemptReopened')).length).toBe(0);
  });
});

// ── AttemptReopened: a resumed worker ────────────────────────────────────────

describe('a worker resuming from its end reopens its owner task through the kernel (AttemptReopened, assigned)', () => {
  test('a completed owner whose worker runs again is assigned; a second resume changes nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/resume', files: { 'src/a.ts': 'export const a = 93;\n' } });
    await w.handOn(pr);
    await q(sql`UPDATE workers SET completed_at = now() - interval '1 minute' WHERE id = ${pr.workerId}::uuid`);
    expect(await status(pr)).toBe('completed');
    expect((await patchWorker(pr, pr.workerId, { status: 'running', reactivate: true })).status).toBe(200);
    expect(await status(pr)).toBe('assigned');
    expect((await patchWorker(pr, pr.workerId, { status: 'running', reactivate: true })).status).toBe(200);
    expect(await status(pr)).toBe('assigned');
  });

  test('late, after the task was claimed again and settled: the old worker\'s reopen moves nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/resume-late', files: { 'src/a.ts': 'export const a = 94;\n' } });
    await w.handOn(pr);
    const [old] = await q<{ completed_at: string }>(sql`UPDATE workers SET completed_at = now() - interval '1 minute' WHERE id = ${pr.workerId}::uuid RETURNING completed_at::text`);
    const next = await reclaim(pr, { workerStatus: 'completed', taskStatus: 'completed' });
    void next;
    expect(await reopenOwner({ task: ownerTask(pr), workerId: pr.workerId, endedAt: new Date(old.completed_at).toISOString(), to: 'assigned', reason: 'resumed', source: 'test', principal })).toBe(false);
    expect(await status(pr)).toBe('completed');
  });

  test('a reopen of an end the worker already moved past (it ended again since) moves nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/resume-end', files: { 'src/a.ts': 'export const a = 95;\n' } });
    await w.handOn(pr);
    await q(sql`UPDATE workers SET completed_at = now() WHERE id = ${pr.workerId}::uuid`);
    expect(await reopenOwner({ task: ownerTask(pr), workerId: pr.workerId, endedAt: new Date(Date.now() - 3_600_000).toISOString(), to: 'assigned', reason: 'resumed', source: 'test', principal })).toBe(false);
    expect(await status(pr)).toBe('completed');
  });
});

// ── AttemptWithdrawn ─────────────────────────────────────────────────────────

describe('a claim that runs no attempt is withdrawn through the kernel (AttemptWithdrawn)', () => {
  /** The owner task assigned under a fresh claim with no worker row since it (the claim's insert was refused). */
  async function claimedWithNoAttempt(pr: OpenedPr): Promise<{ claimedBy: string; claimedAt: string }> {
    const acct = await apiKey('worker');
    await q(sql`UPDATE workers SET status = 'failed', created_at = now() - interval '30 minutes' WHERE task_id = ${pr.ownerTaskId}::uuid`);
    const [r] = await q<{ claimed_at: string }>(sql`UPDATE tasks SET status = 'assigned', claimed_by = ${acct.id}::uuid, claimed_at = now(), expires_at = now() + interval '15 minutes'
      WHERE id = ${pr.ownerTaskId}::uuid RETURNING claimed_at::text`);
    return { claimedBy: acct.id, claimedAt: r.claimed_at };
  }
  const outboxRows = async (taskId: string) => Number((await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM task_dispatch_outbox WHERE task_id = ${taskId}::uuid`))[0].n);

  test('the claim\'s own start goes back to the queue in the WORKING transition; a re-send is a duplicate; a rollback wakes no dispatch', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/withdraw', files: { 'src/a.ts': 'export const a = 96;\n' } });
    const claim = await claimedWithNoAttempt(pr);
    await q(sql`DELETE FROM task_dispatch_outbox WHERE task_id = ${pr.ownerTaskId}::uuid`);
    expect(await withdrawOwner({ task: ownerTask(pr), claim, outcome: 'requeued', reason: 'claim_rollback', source: 'claim', principal })).toBe(true);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedBy: t.claimed_by }).toEqual({ status: 'pending', claimedBy: null });
    expect((await transitions(pr, 'AttemptWithdrawn')).map((x) => x.idempotency_key)).toEqual([`withdraw:${pr.ownerTaskId}:${claim.claimedAt}:requeued`]);
    expect(await outboxRows(pr.ownerTaskId)).toBe(0);
    await withdrawOwner({ task: ownerTask(pr), claim, outcome: 'requeued', reason: 'claim_rollback', source: 'claim', principal });
    expect((await transitions(pr, 'AttemptWithdrawn')).length).toBe(1);
  });

  test('an orphaned claim the cleanup withdraws is new runnable work: dispatch is woken', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/withdraw-wake', files: { 'src/a.ts': 'export const a = 97;\n' } });
    const claim = await claimedWithNoAttempt(pr);
    await q(sql`DELETE FROM task_dispatch_outbox WHERE task_id = ${pr.ownerTaskId}::uuid`);
    expect(await withdrawOwner({ task: ownerTask(pr), claim, outcome: 'requeued', reason: 'orphaned_claim', source: 'tasks-cleanup', principal })).toBe(true);
    expect(await outboxRows(pr.ownerTaskId)).toBeGreaterThan(0);
  });

  test('late, after a new claim, or once the claim\'s worker exists: the withdrawal moves nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/withdraw-late', files: { 'src/a.ts': 'export const a = 98;\n' } });
    const old = await claimedWithNoAttempt(pr);
    // Claimed again (the same account, a later stamp).
    await q(sql`UPDATE tasks SET claimed_at = now() + interval '1 second' WHERE id = ${pr.ownerTaskId}::uuid`);
    expect(await withdrawOwner({ task: ownerTask(pr), claim: old, outcome: 'requeued', reason: 'claim_rollback', source: 'claim', principal })).toBe(false);
    expect(await status(pr)).toBe('assigned');
    // The exact claim, but its attempt row now exists: an attempt runs under it.
    const [r] = await q<{ claimed_at: string }>(sql`SELECT claimed_at::text FROM tasks WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status) VALUES (${w.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'live', 'test', ${pr.branch}, 'running')`);
    expect(await withdrawOwner({ task: ownerTask(pr), claim: { claimedBy: old.claimedBy, claimedAt: r.claimed_at }, outcome: 'failed', reason: 'retry_cap', source: 'test', principal })).toBe(false);
    expect(await status(pr)).toBe('assigned');
  });

  test('a queued task no claim holds is refused for good; a claimed or running one is not', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/refuse', files: { 'src/a.ts': 'export const a = 99;\n' } });
    await q(sql`UPDATE workers SET status = 'failed' WHERE task_id = ${pr.ownerTaskId}::uuid`);
    await q(sql`UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE id = ${pr.ownerTaskId}::uuid`);
    // Claimed by someone (live claim): not refused.
    const acct = await apiKey('worker');
    await q(sql`UPDATE tasks SET claimed_by = ${acct.id}::uuid, claimed_at = now(), expires_at = now() + interval '15 minutes' WHERE id = ${pr.ownerTaskId}::uuid`);
    expect(await withdrawOwner({ task: ownerTask(pr), claim: null, outcome: 'failed', reason: 'workspace_mismatch', source: 'claim', principal })).toBe(false);
    expect(await status(pr)).toBe('pending');
    // Its claim expired: refused, in the WORKING transition.
    await q(sql`UPDATE tasks SET expires_at = now() - interval '1 minute' WHERE id = ${pr.ownerTaskId}::uuid`);
    expect(await withdrawOwner({ task: ownerTask(pr), claim: null, outcome: 'failed', reason: 'workspace_mismatch', source: 'claim', principal })).toBe(true);
    expect(await status(pr)).toBe('failed');
    expect((await transitions(pr, 'AttemptWithdrawn')).map((x) => x.idempotency_key)).toEqual([`withdraw:${pr.ownerTaskId}:queued:failed`]);
  });

  test('a running attempt keeps a queued-looking task: a refusal with a live worker moves nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/refuse-live', files: { 'src/a.ts': 'export const a = 100;\n' } });
    await q(sql`UPDATE tasks SET status = 'pending', claimed_by = NULL WHERE id = ${pr.ownerTaskId}::uuid`);
    expect(await withdrawOwner({ task: ownerTask(pr), claim: null, outcome: 'failed', reason: 'mission_budget', source: 'runner', principal })).toBe(false);
    expect(await status(pr)).toBe('pending');
  });
});

// ── The cleanup route ────────────────────────────────────────────────────────

describe('the cleanup route moves an owner task through its current attempt', () => {
  test('a stalled worker that is the current attempt is requeued (AttemptRequeued); twice is no second move', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/cleanup-requeue', files: { 'src/a.ts': 'export const a = 101;\n' } });
    const admin = await apiKey('admin');
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '3 hours' WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`UPDATE workers SET account_id = ${admin.id}::uuid, created_at = now() - interval '3 hours', updated_at = now() - interval '2 hours' WHERE id = ${pr.workerId}::uuid`);
    expect((await cleanup(admin.id, admin.key)).status).toBe(200);
    expect(await status(pr)).toBe('pending');
    expect((await transitions(pr, 'AttemptRequeued')).map((x) => x.idempotency_key)).toEqual([`requeue:${pr.workerId}`]);
    expect((await cleanup(admin.id, admin.key)).status).toBe(200);
    expect(await status(pr)).toBe('pending');
    expect((await transitions(pr, 'AttemptRequeued')).length).toBe(1);
  });

  test('late: an older worker that went quiet after the task was claimed again leaves the new attempt its task', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/cleanup-late', files: { 'src/a.ts': 'export const a = 102;\n' } });
    const admin = await apiKey('admin');
    const next = await reclaim(pr);
    await q(sql`UPDATE workers SET account_id = ${admin.id}::uuid, updated_at = now() - interval '2 hours' WHERE id = ${pr.workerId}::uuid`);
    expect((await cleanup(admin.id, admin.key)).status).toBe(200);
    expect(await status(pr)).toBe('assigned');
    expect((await transitions(pr, 'AttemptRequeued')).length).toBe(0);
    void next;
  });

  test('a completed current worker on an assigned task is its end (AttemptEnded, success); an older completed one is not', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/cleanup-promote', files: { 'src/a.ts': 'export const a = 103;\n' } });
    const admin = await apiKey('admin');
    // Late first: the completed worker is an older attempt, a newer one failed.
    const next = await reclaim(pr, { workerStatus: 'failed' });
    await q(sql`UPDATE workers SET status = 'completed' WHERE id = ${pr.workerId}::uuid`);
    await q(sql`UPDATE tasks SET updated_at = now() WHERE id = ${pr.ownerTaskId}::uuid`);
    expect((await cleanup(admin.id, admin.key)).status).toBe(200);
    expect(await status(pr)).toBe('assigned');
    // The current attempt completed: its end completes the task.
    await q(sql`UPDATE workers SET status = 'completed', last_commit_sha = ${pr.head}, commit_count = 1 WHERE id = ${next}::uuid`);
    expect((await cleanup(admin.id, admin.key)).status).toBe(200);
    expect(await status(pr)).not.toBe('assigned');
    expect((await transitions(pr, 'AttemptEnded')).map((x) => x.idempotency_key)).toContain(`end:${next}`);
  });
});

// ── The reaper: a question superseded by recovery ────────────────────────────

describe('a question superseded by recovery ends the owner attempt through the kernel', () => {
  async function waiting(pr: OpenedPr, workerId = pr.workerId) {
    const acct = await apiKey('worker');
    await q(sql`UPDATE workers SET status = 'waiting_input', account_id = ${acct.id}::uuid WHERE id = ${workerId}::uuid`);
    return acct.id;
  }

  test('the task fails by the attempt\'s end, ready for the recovery to reopen it', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/superseded', files: { 'src/a.ts': 'export const a = 104;\n' } });
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '1 hour' WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`UPDATE workers SET created_at = now() - interval '50 minutes' WHERE id = ${pr.workerId}::uuid`);
    const acct = await waiting(pr);
    await cleanupStuckWaitingInput(acct, { reason: 'superseded_by_recovery', workerIds: [pr.workerId] });
    expect(await status(pr)).toBe('failed');
    expect((await transitions(pr, 'AttemptEnded')).map((x) => x.idempotency_key)).toEqual([`end:${pr.workerId}`]);
    // The recovery's requeue then reopens it.
    expect(await requeueFailedTasks([pr.ownerTaskId], 'task.requeued')).toEqual([pr.ownerTaskId]);
    expect(await status(pr)).toBe('pending');
  });

  test('late, after the task was claimed again: the older question closes and the new attempt keeps its task', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/superseded-late', files: { 'src/a.ts': 'export const a = 105;\n' } });
    const acct = await waiting(pr);
    await reclaim(pr);
    await cleanupStuckWaitingInput(acct, { reason: 'superseded_by_recovery', workerIds: [pr.workerId] });
    expect(await status(pr)).toBe('assigned');
    expect((await transitions(pr, 'AttemptEnded')).length).toBe(0);
  });
});

// ── The worker PATCH: a loop exhausted ───────────────────────────────────────

describe('a completion the PATCH overrides to failed is the attempt\'s failed end', () => {
  test('loop attempts exhausted: the end is sent failed and projected; the statement writes the loop fields only', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/loop-exhausted', files: { 'src/a.ts': 'export const a = 106;\n' } });
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '5 minutes',
      loop_config = ${JSON.stringify({ exitCondition: { type: 'pr_merged' }, maxLoops: 1 })}::jsonb, loop_iteration = 1 WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`UPDATE workers SET created_at = now() - interval '4 minutes' WHERE id = ${pr.workerId}::uuid`);
    const res = await patchWorker(pr, pr.workerId, { status: 'completed', summary: 'Pushed the change.', commitCount: 1, lastCommitSha: pr.head });
    expect(res.status).toBe(200);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, loop: t.loop_state }).toEqual({ status: 'failed', loop: 'exhausted' });
    const ends = await transitions(pr, 'AttemptEnded');
    expect(ends.map((x) => [x.idempotency_key, x.evidence.outcome])).toEqual([[`end:${pr.workerId}`, 'failed']]);
  });
});

// ── Loop exits: T17's open-PR rule ───────────────────────────────────────────

describe('a loop exit leaves a task with another open PR open', () => {
  test('checks green on one PR while the task\'s other PR is still open: the parked task stays in the queue', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/loop-two-prs', files: { 'src/a.ts': 'export const a = 107;\n' } });
    await q(sql`UPDATE tasks SET loop_config = ${JSON.stringify({ exitCondition: { type: 'pr_checks_green' }, maxLoops: 3, waitExpiryMinutes: 240 })}::jsonb,
      status = 'assigned', claimed_at = now() - interval '5 minutes' WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`UPDATE workers SET created_at = now() - interval '4 minutes' WHERE id = ${pr.workerId}::uuid`);
    expect((await patchWorker(pr, pr.workerId, { status: 'completed', summary: 'Opened the PR.', commitCount: 1, lastCommitSha: pr.head })).status).toBe(200);
    expect(await status(pr)).toBe('pending');
    // A second PR of the same task, still open.
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_number, pr_url)
      VALUES (${w.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'sibling', 'external', 'feat/other', 'completed', 9999, ${`https://github.com/${w.repo}/pull/9999`})`);
    await evaluateAndAdvanceLoopOnCiGreen(pr.workerId, pr.ownerTaskId, w.workspaceId, 'ci_green');
    expect(await status(pr)).toBe('pending');
  });
});

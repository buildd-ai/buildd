/**
 * AC-1 slice 3 (docs/specs/workflow-kernel-library.md §9): the end of a kernel delivery's owner
 * attempt is projected onto its task by the kernel, starting with the worker PATCH family.
 *
 *  - T4 for an owner sets the task in the transition's own statement (`t_attempt`), reading the
 *    delivery CTE, so a version miss writes nothing.
 *  - It moves only an open task (assigned, legacy in_progress): a cancel, a requeue to pending or a
 *    completion some other writer made is kept.
 *  - An end that applies nothing (a duplicate, a stale end) still projects: from the ledger's
 *    recorded end when there is one, else from the end that was sent.
 *  - The worker PATCH writes an owner's result but not its status; the projection does.
 *
 * Real kernel, real Postgres, stateful fake GitHub, the real worker route with API-key auth.
 */
import { seam, world, type OpenedPr, type World } from './workflow-scenarios-world';
import { afterEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { confinedRunnerEnvironment, q, seedTask } from './harness';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

const workersRoute = await import('../../src/app/api/workers/[id]/route');
const claimRoute = await import('../../src/app/api/workers/claim/route');
const { transitionSql } = await import('../../src/lib/workflow/kernel');

setDefaultTimeout(30_000);

let w: World | undefined;
afterEach(() => w?.dispose());

const status = (pr: OpenedPr) => w!.taskStatus(pr.ownerTaskId);
const setTask = (pr: OpenedPr, s: string) => q(sql`UPDATE tasks SET status = ${s}, claimed_at = now() WHERE id = ${pr.ownerTaskId}::uuid`);
const endCount = async (pr: OpenedPr) =>
  (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM workflow_transitions WHERE delivery_id = ${pr.deliveryId}::uuid AND command = 'AttemptEnded'`))[0].n;

function end(pr: OpenedPr, o: { workerId?: string; status: 'completed' | 'failed' | 'lost' | 'unproven'; commitCount?: number; localHeadSha?: string | null; taskRetryBudgetLeft?: boolean }) {
  return seam.attemptEnded({
    task: { id: pr.ownerTaskId, workspaceId: w!.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null },
    workerId: o.workerId ?? pr.workerId,
    status: o.status,
    localHeadSha: o.localHeadSha === undefined ? w!.gh.pr(w!.repo, pr.prNumber).headSha : o.localHeadSha,
    commitCount: o.commitCount ?? 1,
    source: 'runner',
    ...(o.taskRetryBudgetLeft ? { taskRetryBudgetLeft: true } : {}),
  });
}

describe('T4 projects the owner attempt\'s end onto its task', () => {
  test('a completed owner end completes the assigned task in the transition\'s own statement', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/proj-success', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await setTask(pr, 'assigned');
    const r = await end(pr, { status: 'completed' });
    expect(r.result?.result).toBe('applied');
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    expect(await status(pr)).toBe('completed');
  });

  test('a failed owner end fails the task; a lost one too', async () => {
    w = await world();
    const a = await w.openPr({ branch: 'feat/proj-failed', files: { 'src/a.ts': 'export const a = 3;\n' } });
    await setTask(a, 'assigned');
    await end(a, { status: 'failed' });
    expect(await status(a)).toBe('failed');

    const b = await w.openPr({ branch: 'feat/proj-lost', files: { 'src/b.ts': 'export const b = 3;\n' } });
    await end(b, { status: 'lost', localHeadSha: null, commitCount: 0 });
    // Legacy `in_progress` is open too.
    expect(await status(b)).toBe('failed');
  });

  test('a version miss writes nothing: the projection reads the delivery CTE', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/proj-cas-miss', files: { 'src/a.ts': 'export const a = 4;\n' } });
    await setTask(pr, 'assigned');
    const d = await w.delivery(pr);
    const res = await q(transitionSql({
      result: 'apply', command: 'AttemptEnded', idempotencyKey: `end:${pr.workerId}`, fromState: 'WORKING', toState: 'AWAITING_PUSH',
      guard: { version: d.version + 7, states: ['WORKING'] }, patch: {}, rounds: [], attempts: [], effects: [],
      evidence: { outcome: 'success', localHeadSha: null, commitCount: 1 },
    }, { deliveryId: pr.deliveryId }));
    expect(res).toEqual([]);
    expect(await status(pr)).toBe('assigned');
    expect((await w.delivery(pr)).state).toBe('WORKING');
  });

  test('the transition statement itself writes the task (no seam step after it)', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/proj-cas-hit', files: { 'src/a.ts': 'export const a = 4;\n' } });
    await setTask(pr, 'assigned');
    const d = await w.delivery(pr);
    const res = await q(transitionSql({
      result: 'apply', command: 'AttemptEnded', idempotencyKey: `end:${pr.workerId}`, fromState: 'WORKING', toState: 'AWAITING_PUSH',
      guard: { version: d.version, states: ['WORKING'] }, patch: {}, rounds: [], attempts: [], effects: [],
      evidence: { outcome: 'success', localHeadSha: null, commitCount: 1 },
    }, { deliveryId: pr.deliveryId }));
    expect(res.length).toBe(1);
    expect(await status(pr)).toBe('completed');
  });

  test('a settled task keeps its status: cancelled, a requeue to pending, a completion', async () => {
    w = await world();
    const cancelled = await w.openPr({ branch: 'feat/proj-cancel', files: { 'src/a.ts': 'export const a = 5;\n' } });
    await setTask(cancelled, 'cancelled');
    await end(cancelled, { status: 'failed' });
    expect(await status(cancelled)).toBe('cancelled');

    // A loop hold: the PATCH requeued the task, then sent the completed end.
    const held = await w.openPr({ branch: 'feat/proj-hold', files: { 'src/b.ts': 'export const b = 5;\n' } });
    await setTask(held, 'pending');
    await end(held, { status: 'completed' });
    expect(await status(held)).toBe('pending');
    expect((await w.delivery(held)).state).toBe('AWAITING_REVIEW');

    const done = await w.openPr({ branch: 'feat/proj-done', files: { 'src/c.ts': 'export const c = 5;\n' } });
    await setTask(done, 'completed');
    await end(done, { status: 'failed' });
    expect(await status(done)).toBe('completed');
  });

  test('a requeue the kernel records (the task\'s own retry is queued) projects nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/proj-requeue', files: { 'src/a.ts': 'export const a = 6;\n' } });
    await setTask(pr, 'assigned');
    await end(pr, { status: 'unproven', localHeadSha: null, commitCount: 0, taskRetryBudgetLeft: true });
    expect((await w.delivery(pr)).state).toBe('WORKING');
    expect(await status(pr)).toBe('assigned');
  });

  test('a duplicate end projects the ledger\'s recorded end, not the one re-sent', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/proj-dup', files: { 'src/a.ts': 'export const a = 7;\n' } });
    await setTask(pr, 'assigned');
    await end(pr, { status: 'completed' });
    // An end the kernel applied before it projected (an older build): the task is still open.
    await setTask(pr, 'assigned');
    const again = await end(pr, { status: 'failed' });
    expect(again.result?.result).toBe('duplicate');
    expect(await endCount(pr)).toBe(1);
    expect(await status(pr)).toBe('completed');
  });

  test('a stale end (the delivery moved past WORKING) still settles its open task from the end sent', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/proj-stale', files: { 'src/a.ts': 'export const a = 8;\n' } });
    await w.handOn(pr);
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    // A second attempt of the same task ends after the hand-off.
    await setTask(pr, 'assigned');
    const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
      VALUES (${w.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'w2', 'test', ${pr.branch}, 'failed') RETURNING id`);
    const r = await end(pr, { workerId: wk.id, status: 'failed' });
    expect(r.result?.result).toBe('stale');
    expect(await status(pr)).toBe('failed');
  });

  // Review of #5049: an end that lands late, after its task was requeued and claimed again,
  // belongs to the attempt before and must not settle the new one.
  async function reclaimed(pr: OpenedPr, o: { newWorker: boolean }): Promise<void> {
    await q(sql`UPDATE workers SET status = 'completed', created_at = now() - interval '10 minutes' WHERE id = ${pr.workerId}::uuid`);
    // The requeue (loop hold or retry) put the task back to pending; a runner claims it again.
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() WHERE id = ${pr.ownerTaskId}::uuid`);
    if (o.newWorker) {
      await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
        VALUES (${w!.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'w2', 'test', ${pr.branch}, 'running')`);
    }
  }

  test('loop hold: requeued, claimed again, then the old completed end lands late: the new attempt stays assigned', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/late-hold', files: { 'src/a.ts': 'export const a = 20;\n' } });
    await reclaimed(pr, { newWorker: true });
    const r = await end(pr, { status: 'completed' });
    expect(r.result?.result).toBe('applied');
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    expect(await status(pr)).toBe('assigned');
  });

  test('retry: an unproven end with commits and retry budget lands after the re-claim: AWAITING_PUSH, the new attempt stays assigned', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/late-retry', files: { 'src/a.ts': 'export const a = 21;\n' } });
    await reclaimed(pr, { newWorker: true });
    const r = await end(pr, { status: 'unproven', localHeadSha: 'f'.repeat(40), commitCount: 2, taskRetryBudgetLeft: true });
    expect(r.result?.result).toBe('applied');
    expect((await w.delivery(pr)).state).toBe('AWAITING_PUSH');
    expect(await status(pr)).toBe('assigned');
  });

  test('a re-claim in flight (claimed_at stamped, the new worker row not inserted yet): a late end does not settle it', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/late-inflight', files: { 'src/a.ts': 'export const a = 22;\n' } });
    await reclaimed(pr, { newWorker: false });
    await end(pr, { status: 'failed' });
    expect(await status(pr)).toBe('assigned');
  });

  test('past WORKING with the owner task still open (an older control plane applied the end without projecting): the floor settles it', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/floor-past-working', files: { 'src/a.ts': 'export const a = 23;\n' } });
    await w.handOn(pr);
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    // As an older control plane leaves it: the end applied, the task untouched; the worker settled.
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '40 minutes' WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`UPDATE workers SET created_at = now() - interval '35 minutes', updated_at = now() - interval '30 minutes' WHERE id = ${pr.workerId}::uuid`);
    await w.floor(pr);
    expect(await status(pr)).toBe('completed');
  });

  test('past WORKING, the latest worker still settling: the floor leaves the task for now', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/floor-settling', files: { 'src/a.ts': 'export const a = 24;\n' } });
    await w.handOn(pr);
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '40 minutes' WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`UPDATE workers SET created_at = now() - interval '35 minutes', updated_at = now() WHERE id = ${pr.workerId}::uuid`);
    await w.floor(pr);
    expect(await status(pr)).toBe('assigned');
  });

  test('a task that is not the delivery\'s owner is never projected', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/proj-not-owner', files: { 'src/a.ts': 'export const a = 9;\n' } });
    const other = await w.openPr({ branch: 'feat/proj-other', files: { 'src/b.ts': 'export const b = 9;\n' } });
    await setTask(other, 'assigned');
    expect(await seam.projectOwnerEnd({ deliveryId: pr.deliveryId, taskId: other.ownerTaskId, workerId: other.workerId, status: 'completed' })).toBeNull();
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
  const res = await workersRoute.PATCH(
    new NextRequest(`http://localhost/api/workers/${pr.workerId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: pr.workerId }) } as never,
  );
  return res;
}

describe('the worker PATCH leaves an owner\'s status to the projection', () => {
  test('completed: the task is completed by the end, its result is the PATCH\'s, the delivery hands on', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/patch-success', files: { 'src/a.ts': 'export const a = 10;\n' } });
    await setTask(pr, 'assigned');
    const res = await patchWorker(pr, { status: 'completed', summary: 'shipped the thing', commitCount: 1, lastCommitSha: pr.head });
    expect(res.status).toBe(200);
    const [t] = await q<{ status: string; result: Record<string, unknown> | null }>(sql`SELECT status, result FROM tasks WHERE id = ${pr.ownerTaskId}::uuid`);
    expect(t.status).toBe('completed');
    expect(t.result?.summary).toBe('shipped the thing');
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    expect(await endCount(pr)).toBe(1);
  });

  test('failed with no retry: the end fails the task', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/patch-failed', files: { 'src/a.ts': 'export const a = 11;\n' } });
    await setTask(pr, 'assigned');
    const res = await patchWorker(pr, { status: 'failed', error: 'tests are red' });
    expect(res.status).toBe(200);
    expect(await status(pr)).toBe('failed');
    expect(await endCount(pr)).toBe(1);
  });

  test('a delivery the kill switch released: the PATCH still settles the task (the route\'s own projection)', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/patch-released', files: { 'src/a.ts': 'export const a = 12;\n' } });
    await setTask(pr, 'assigned');
    await q(sql`UPDATE workflow_deliveries SET authority = 'legacy' WHERE id = ${pr.deliveryId}::uuid`);
    const res = await patchWorker(pr, { status: 'completed', summary: 'done', commitCount: 1, lastCommitSha: pr.head });
    expect(res.status).toBe(200);
    expect(await status(pr)).toBe('completed');
    expect(await endCount(pr)).toBe(0);
  });
});

// ── Review of #5049, round 2 ─────────────────────────────────────────────────

/** The sibling row worker-pr-slot.ts inserts when a running worker opens a second PR. */
async function siblingRow(pr: OpenedPr, o: { minutesAgo?: number } = {}): Promise<string> {
  const ago = o.minutesAgo ?? 0;
  const [r] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_number, pr_url, created_at, updated_at)
    VALUES (${w!.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'w · PR #9', 'external', 'second-pr', 'completed', ${pr.prNumber + 1000},
      ${`https://github.com/${w!.repo}/pull/${pr.prNumber + 1000}`}, now() - make_interval(mins => ${ago}::int), now() - make_interval(mins => ${ago}::int))
    RETURNING id`);
  return r.id;
}

describe('a placeholder worker row is never the current attempt', () => {
  test('A: a second PR\'s sibling row, then the owner\'s genuine completed PATCH: the task completes', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/sibling-done', files: { 'src/a.ts': 'export const a = 30;\n' } });
    await setTask(pr, 'assigned');
    await siblingRow(pr);
    const res = await patchWorker(pr, { status: 'completed', summary: 'done', commitCount: 1, lastCommitSha: pr.head });
    expect(res.status).toBe(200);
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    expect(await status(pr)).toBe('completed');
  });

  test('B: the same with a genuine failed end: the task fails, and the floor never turns it completed', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/sibling-failed', files: { 'src/a.ts': 'export const a = 31;\n' } });
    await setTask(pr, 'assigned');
    await siblingRow(pr);
    const res = await patchWorker(pr, { status: 'failed', error: 'red' });
    expect(res.status).toBe(200);
    expect(await status(pr)).toBe('failed');
    await w.floor(pr);
    expect(await status(pr)).toBe('failed');
  });

  test('B (floor): past WORKING, the real attempt failed and a newer sibling says completed: the floor projects failed', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/sibling-floor', files: { 'src/a.ts': 'export const a = 32;\n' } });
    // An older control plane applied the real attempt's failed end without projecting it.
    await q(sql`UPDATE workers SET status = 'failed' WHERE id = ${pr.workerId}::uuid`);
    await end(pr, { status: 'failed' });
    expect((await w.delivery(pr)).state).not.toBe('WORKING');
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '60 minutes' WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`UPDATE workers SET status = 'failed', created_at = now() - interval '50 minutes', updated_at = now() - interval '40 minutes' WHERE id = ${pr.workerId}::uuid`);
    await siblingRow(pr, { minutesAgo: 30 });
    await w.floor(pr);
    expect(await status(pr)).toBe('failed');
  });

  test('C: past WORKING, a re-claimed attempt still running (with its own sibling row): the floor leaves the task', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/sibling-running', files: { 'src/a.ts': 'export const a = 33;\n' } });
    await w.handOn(pr);
    await q(sql`UPDATE workers SET created_at = now() - interval '60 minutes', updated_at = now() - interval '50 minutes' WHERE id = ${pr.workerId}::uuid`);
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '45 minutes' WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, created_at, updated_at)
      VALUES (${w.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'w2', 'test', ${pr.branch}, 'running', now() - interval '44 minutes', now() - interval '30 minutes')`);
    await siblingRow(pr, { minutesAgo: 25 });
    await w.floor(pr);
    expect(await status(pr)).toBe('assigned');
  });
});

describe('claimed_at is on the database clock', () => {
  test('D: a real claim stamps claimed_at no later than the worker row it inserts, so the attempt\'s end projects', async () => {
    w = await world();
    const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w.workspaceId}::uuid`);
    const account = await serviceKey(ws.team_id);
    await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${w.workspaceId}::uuid`);
    const taskId = await seedTask(w.workspaceId, { title: 'claim clock' });
    const req = new NextRequest('http://localhost/api/workers/claim', {
      method: 'POST',
      headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runner: `r-${Date.now()}`, maxTasks: 1, workspaceId: w.workspaceId, taskId, environment: confinedRunnerEnvironment() }),
    });
    // The web host's clock runs 30 s ahead of the database's.
    const RealDate = Date;
    const SKEW = 30_000;
    class AheadDate extends RealDate {
      constructor(...a: unknown[]) { if (a.length) super(...(a as [number])); else super(RealDate.now() + SKEW); }
      static now() { return RealDate.now() + SKEW; }
    }
    globalThis.Date = AheadDate as unknown as DateConstructor;
    let res: Response;
    try { res = await claimRoute.POST(req as never); } finally { globalThis.Date = RealDate; }
    const body = await res.json() as { workers?: unknown[] };
    expect(`${res.status} ${body.workers?.length ? 'claimed' : JSON.stringify(body)}`).toBe('200 claimed');
    const [row] = await q<{ ok: boolean; claimed: boolean }>(sql`
      SELECT t.claimed_at IS NOT NULL AS claimed, t.claimed_at <= wk.created_at AS ok
      FROM tasks t JOIN workers wk ON wk.task_id = t.id WHERE t.id = ${taskId}::uuid`);
    expect(row).toEqual({ claimed: true, ok: true });
  });
});

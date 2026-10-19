/**
 * AC-1 slice 8 (docs/specs/workflow-kernel-library.md §9): the last attempt-site writers of a kernel
 * owner task's status go through the kernel.
 *
 *  - CI retries exhausted: the transition that escalates the delivery fails the owner task in its
 *    own statement (`t_escalate`); `escalateCiRedHead` (the Escalate effect) writes no status for it.
 *  - Loop exits: a merge is T17's to complete; a green-checks exit re-sends the held attempt's end
 *    (AttemptEnded) and completes the parked task under the projection's guard (`projectLoopExit`).
 *  - The worker PATCH's silent-completion retry is a requeue (AttemptRequeued) and its last refusal
 *    the attempt's failed end (AttemptEnded); the budget and auth-failover requeues too.
 *  - The reaper's infra requeue and its release of an interactive or undelivered claim are requeues
 *    (AttemptRequeued); its expired loop waits and reviewer rounds never move a kernel owner.
 *  - Every path is checked late (after the task was claimed again) and twice (a re-send).
 *
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
// The auth failover's backend choice reads team credentials this world has none of: pin it per test.
let failoverTo: 'codex' | 'claude' | null = null;
const realFailover = await import('../../src/lib/backend-failover');
mock.module('../../src/lib/backend-failover', () => ({
  ...realFailover,
  resolveFailoverBackend: async () => ({ backend: failoverTo, blocked: [] }),
}));

const workersRoute = await import('../../src/app/api/workers/[id]/route');
const { escalateCiRedHead } = await import('../../src/lib/ci-failure-retry');
const { evaluateAndAdvanceLoopOnCiGreen, evaluateAndAdvanceLoopOnMerge } = await import('../../src/lib/loop-webhook');
const { resolveTasksOfReapedWorkers } = await import('../../src/lib/stale-workers');
const { transitionSql } = await import('../../src/lib/workflow/kernel');
const { detachInteractiveWorker } = await import('../../src/lib/interactive-detach');

setDefaultTimeout(30_000);

let w: World | undefined;
afterEach(() => {
  w?.dispose();
  failoverTo = null;
});

type TaskRow = { status: string; claimed_at: string | null; claimed_by: string | null; context: Record<string, unknown> | null; start_at: string | null; result: Record<string, unknown> | null; loop_state: string | null; backend: string | null };
const taskRow = async (id: string) =>
  (await q<TaskRow>(sql`SELECT status, claimed_at, claimed_by, context, start_at, result, loop_state, backend FROM tasks WHERE id = ${id}::uuid`))[0];
const status = (pr: OpenedPr) => w!.taskStatus(pr.ownerTaskId);
const transitions = (pr: OpenedPr, command: string) =>
  q<{ idempotency_key: string; evidence: Record<string, unknown> }>(sql`SELECT idempotency_key, evidence FROM workflow_transitions
    WHERE delivery_id = ${pr.deliveryId}::uuid AND command = ${command} ORDER BY to_version`);
/** The owner task as a runner holds it while its attempt runs. */
const assigned = (pr: OpenedPr) => q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '5 minutes' WHERE id = ${pr.ownerTaskId}::uuid`);

/** A runner claimed the task again: its new attempt row is newer than every earlier one. */
async function reclaim(pr: OpenedPr, o: { workerStatus?: string; branch?: string } = {}): Promise<string> {
  await q(sql`UPDATE workers SET created_at = now() - interval '10 minutes' WHERE task_id = ${pr.ownerTaskId}::uuid`);
  await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '1 minute' WHERE id = ${pr.ownerTaskId}::uuid`);
  const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
    VALUES (${w!.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'next', 'test', ${o.branch ?? pr.branch}, ${o.workerStatus ?? 'running'}) RETURNING id`);
  return wk.id;
}

async function serviceKey(teamId: string): Promise<{ id: string; key: string }> {
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hashed = createHash('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${hashed}, ${teamId}::uuid, 'worker', 10) RETURNING id`);
  return { id: a.id, key };
}

async function patchWorker(pr: OpenedPr, workerId: string, body: Record<string, unknown>, o: { outputRequirement?: string } = {}) {
  const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w!.workspaceId}::uuid`);
  const account = await serviceKey(ws.team_id);
  await q(sql`UPDATE workers SET account_id = ${account.id}::uuid WHERE id = ${workerId}::uuid`);
  await q(sql`UPDATE tasks SET output_requirement = ${o.outputRequirement ?? 'none'} WHERE id = ${pr.ownerTaskId}::uuid`);
  return workersRoute.PATCH(
    new NextRequest(`http://localhost/api/workers/${workerId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: workerId }) } as never,
  );
}

// ── CI retries exhausted ─────────────────────────────────────────────────────

describe('an exhausted CI repair fails the owner task in the escalating transition', () => {
  /** The owner handed its head on (the task completed), then CI went red with no repair budget left. */
  async function redWithNoBudget(pr: OpenedPr) {
    await w!.handOn(pr);
    expect(await status(pr)).toBe('completed');
    w!.gh.setCheck(w!.repo, pr.head, 'build', { conclusion: 'failure' });
    return seam.observeCiFailure({ workspaceId: w!.workspaceId, repoFullName: w!.repo, prNumber: pr.prNumber, installationId: w!.installationId, headSha: pr.head, signature: 'ci_failed', maxAttempts: 0, source: 'webhook:check_suite' });
  }

  test('ESCALATED (ci_exhausted): the owner task is failed by the transition, and the effect still records why', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/esc-ci', files: { 'src/a.ts': 'export const a = 40;\n' } });
    const seen = await redWithNoBudget(pr);
    expect(seen).toMatchObject({ handled: true, result: { result: 'applied' } });
    const d = await w.delivery(pr);
    expect({ state: d.state, reason: d.stateReason }).toEqual({ state: 'ESCALATED', reason: 'ci_exhausted' });
    const t = await taskRow(pr.ownerTaskId);
    expect(t.status).toBe('failed');
    expect(String(t.result?.summary ?? '')).toContain('CI retry stopped');
  });

  test('a version miss writes nothing: `t_escalate` reads the delivery CTE, and at the version read it fails the task itself', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/esc-cas', files: { 'src/a.ts': 'export const a = 44;\n' } });
    await w.handOn(pr);
    const d = await w.delivery(pr);
    const decision = {
      result: 'apply' as const, command: 'CiFailedObserved' as const, idempotencyKey: `ci:${pr.deliveryId}:${pr.head}:exhausted`, fromState: d.state, toState: 'ESCALATED' as const,
      patch: { stateReason: 'ci_exhausted' }, rounds: [], attempts: [], evidence: { signature: 'ci_failed' },
      effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${pr.deliveryId}:ci:${pr.head}@v${d.version}`, payload: { family: 'ci', attempts: 0, max: 0, headSha: pr.head } }],
    };
    expect(await q(transitionSql({ ...decision, guard: { version: d.version + 7, states: [d.state] } } as never, { deliveryId: pr.deliveryId }))).toEqual([]);
    expect(await status(pr)).toBe('completed');
    expect((await q(transitionSql({ ...decision, guard: { version: d.version, states: [d.state] } } as never, { deliveryId: pr.deliveryId }))).length).toBe(1);
    expect(await status(pr)).toBe('failed');
  });

  test('the Escalate effect\'s own write never sets a kernel owner\'s status: a re-run on a new head keeps what the task has', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/esc-effect', files: { 'src/a.ts': 'export const a = 41;\n' } });
    await w.handOn(pr);
    // A person re-claimed the owner task after an escalation; a late or retried effect arrives.
    await reclaim(pr);
    const task = (await q<{ id: string; title: string; workspace_id: string; result: unknown }>(sql`SELECT id, title, workspace_id, result FROM tasks WHERE id = ${pr.ownerTaskId}::uuid`))[0];
    const input = {
      installationId: w.installationId, repoFullName: w.repo, prNumber: pr.prNumber, headSha: 'f'.repeat(40),
      task: { id: task.id, title: task.title, workspaceId: task.workspace_id, missionId: null, result: task.result },
      detail: 'retries spent', missionTitle: 't', missionMessage: 'm',
    };
    expect(await escalateCiRedHead(input)).toBe(true);
    expect(await status(pr)).toBe('assigned');
    // Once per head: the same head again changes nothing.
    expect(await escalateCiRedHead(input)).toBe(false);
  });

  test('a delivery the kill switch released is legacy: the escalation write fails the task itself', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/esc-legacy', files: { 'src/a.ts': 'export const a = 42;\n' } });
    await w.handOn(pr);
    await q(sql`UPDATE workflow_deliveries SET authority = 'legacy' WHERE id = ${pr.deliveryId}::uuid`);
    const task = (await q<{ id: string; title: string; workspace_id: string }>(sql`SELECT id, title, workspace_id FROM tasks WHERE id = ${pr.ownerTaskId}::uuid`))[0];
    expect(await escalateCiRedHead({
      installationId: w.installationId, repoFullName: w.repo, prNumber: pr.prNumber, headSha: pr.head,
      task: { id: task.id, title: task.title, workspaceId: task.workspace_id, missionId: null, result: null },
      detail: 'retries spent', missionTitle: 't', missionMessage: 'm',
    })).toBe(true);
    expect(await status(pr)).toBe('failed');
  });

  test('a re-sent red observation after the escalation is no second transition, and the failed task stays failed', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/esc-dup', files: { 'src/a.ts': 'export const a = 43;\n' } });
    await redWithNoBudget(pr);
    const before = (await w.commands(pr)).length;
    await seam.observeCiFailure({ workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId, headSha: pr.head, signature: 'ci_failed', maxAttempts: 0, source: 'webhook:check_suite' });
    expect((await w.commands(pr)).length).toBe(before);
    expect(await status(pr)).toBe('failed');
  });
});

// ── Loop exits ───────────────────────────────────────────────────────────────

describe('a loop exit leaves a kernel owner\'s status to the kernel', () => {
  /** A loop task whose attempt completed before its checks reported: parked in the queue. */
  async function held(pr: OpenedPr, exit: 'pr_checks_green' | 'pr_merged') {
    await q(sql`UPDATE tasks SET loop_config = ${JSON.stringify({ exitCondition: { type: exit }, maxLoops: 3, waitExpiryMinutes: 240 })}::jsonb WHERE id = ${pr.ownerTaskId}::uuid`);
    await assigned(pr);
    const res = await patchWorker(pr, pr.workerId, { status: 'completed', summary: 'Pushed the change and opened the PR.', commitCount: 1, lastCommitSha: pr.head });
    expect(res.status).toBe(200);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, loop: t.loop_state }).toEqual({ status: 'pending', loop: 'condition_unmet' });
    expect((await transitions(pr, 'AttemptEnded')).map((x) => x.idempotency_key)).toEqual([`end:${pr.workerId}`]);
  }

  test('checks green: the held attempt\'s end is re-sent (a duplicate) and the parked task completes', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/loop-green', files: { 'src/a.ts': 'export const a = 50;\n' } });
    await held(pr, 'pr_checks_green');
    expect(await evaluateAndAdvanceLoopOnCiGreen(pr.workerId, pr.ownerTaskId, w.workspaceId, 'ci_green')).toBe(true);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, loop: t.loop_state }).toEqual({ status: 'completed', loop: 'satisfied' });
    expect((await transitions(pr, 'AttemptEnded')).length).toBe(1);
    // Twice (a redelivered check_suite): the loop's compare-and-set already moved, nothing else happens.
    expect(await evaluateAndAdvanceLoopOnCiGreen(pr.workerId, pr.ownerTaskId, w.workspaceId, 'ci_green')).toBe(false);
    expect(await status(pr)).toBe('completed');
    expect((await transitions(pr, 'AttemptEnded')).length).toBe(1);
  });

  test('checks green late, after the next iteration was claimed: the running attempt keeps its task', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/loop-green-late', files: { 'src/a.ts': 'export const a = 51;\n' } });
    await held(pr, 'pr_checks_green');
    // The claim of the next iteration: still parked on the loop's condition, a live attempt on it.
    await reclaim(pr);
    await evaluateAndAdvanceLoopOnCiGreen(pr.workerId, pr.ownerTaskId, w.workspaceId, 'ci_green');
    expect(await status(pr)).toBe('assigned');
  });

  test('a merge: T17 completes a runner\'s task in its own statement, and the loop writes only its own fields', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/loop-merged', files: { 'src/a.ts': 'export const a = 52;\n' } });
    await held(pr, 'pr_merged');
    await w.approve(pr);
    await w.land(pr, pr.head);
    expect((await w.delivery(pr)).state).toBe('MERGED');
    expect(await status(pr)).toBe('completed');
    await evaluateAndAdvanceLoopOnMerge(pr.workerId, pr.ownerTaskId, w.workspaceId);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, loop: t.loop_state }).toEqual({ status: 'completed', loop: 'satisfied' });
  });

  test('a merge of a task a local session ran: T17 leaves it to the session, whose attempt already ended, so the loop exit completes it', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/loop-merged-session', files: { 'src/a.ts': 'export const a = 54;\n' } });
    await held(pr, 'pr_merged');
    // T17 does not complete a task run from a local session (the session completes its own).
    await q(sql`UPDATE workers SET runner = 'mcp' WHERE id = ${pr.workerId}::uuid`);
    await w.approve(pr);
    await w.land(pr, pr.head);
    expect((await w.delivery(pr)).state).toBe('MERGED');
    // The merge's own fan-out may already have advanced the loop; either way it is advanced once.
    await evaluateAndAdvanceLoopOnMerge(pr.workerId, pr.ownerTaskId, w.workspaceId);
    expect(await evaluateAndAdvanceLoopOnMerge(pr.workerId, pr.ownerTaskId, w.workspaceId)).toBe(false);
    // When the fan-out won the loop's compare-and-set, its projection of the parked task runs
    // unawaited (mission-subscribers): wait for it rather than read the task mid-flight.
    let t = await taskRow(pr.ownerTaskId);
    for (let i = 0; i < 50 && t.status !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      t = await taskRow(pr.ownerTaskId);
    }
    expect({ status: t.status, loop: t.loop_state }).toEqual({ status: 'completed', loop: 'satisfied' });
  });

  test('a merge while the session that runs the task is still live: the loop exit leaves its task to it', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/loop-merged-live', files: { 'src/a.ts': 'export const a = 55;\n' } });
    await held(pr, 'pr_merged');
    await q(sql`UPDATE workers SET runner = 'mcp' WHERE id = ${pr.workerId}::uuid`);
    await w.approve(pr);
    // A session is running the task again when the merge lands.
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
      VALUES (${w.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'live', 'mcp', ${pr.branch}, 'running')`);
    await w.land(pr, pr.head);
    await evaluateAndAdvanceLoopOnMerge(pr.workerId, pr.ownerTaskId, w.workspaceId);
    expect(await status(pr)).toBe('pending');
  });

  test('a delivery the kill switch released is legacy: the green-checks exit completes the task itself', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/loop-legacy', files: { 'src/a.ts': 'export const a = 53;\n' } });
    await held(pr, 'pr_checks_green');
    await q(sql`UPDATE workflow_deliveries SET authority = 'legacy' WHERE id = ${pr.deliveryId}::uuid`);
    await q(sql`UPDATE workers SET status = 'running' WHERE id = ${pr.workerId}::uuid`);
    expect(await evaluateAndAdvanceLoopOnCiGreen(pr.workerId, pr.ownerTaskId, w.workspaceId, 'ci_green')).toBe(true);
    expect(await status(pr)).toBe('completed');
  });
});

// ── The worker PATCH ─────────────────────────────────────────────────────────

describe('the worker PATCH moves a kernel owner through the kernel', () => {
  /** A second attempt (after a requeue) that ends with nothing but narration: the silent-completion gate. */
  async function silentAttempt(pr: OpenedPr, retryCount: number) {
    await q(sql`UPDATE tasks SET kind = 'engineering', context = jsonb_build_object('silentCompletionRetryCount', ${retryCount}::int) WHERE id = ${pr.ownerTaskId}::uuid`);
    return reclaim(pr, { branch: `${pr.branch}-retry` });
  }
  const silentBody = { status: 'completed', summary: 'Now let me look at the files', summarySource: 'fallback' };

  test('silent completion with its retry left: pending through AttemptRequeued, the retry counted, the claim released', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/silent-retry', files: { 'src/a.ts': 'export const a = 60;\n' } });
    const attempt = await silentAttempt(pr, 0);
    const res = await patchWorker(pr, attempt, silentBody, { outputRequirement: 'auto' });
    expect(res.status).toBe(400);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedAt: t.claimed_at, retries: t.context?.silentCompletionRetryCount }).toEqual({ status: 'pending', claimedAt: null, retries: 1 });
    expect((await transitions(pr, 'AttemptRequeued')).map((x) => x.idempotency_key)).toEqual([`requeue:${attempt}`]);
    expect((await w.delivery(pr)).state).toBe('WORKING');
  });

  test('silent completion with its retry spent: the attempt\'s failed end goes to the kernel, which fails the task', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/silent-spent', files: { 'src/a.ts': 'export const a = 61;\n' } });
    const attempt = await silentAttempt(pr, 1);
    const res = await patchWorker(pr, attempt, silentBody, { outputRequirement: 'auto' });
    expect(res.status).toBe(400);
    expect(await status(pr)).toBe('failed');
    const ends = await transitions(pr, 'AttemptEnded');
    expect(ends.map((x) => [x.idempotency_key, x.evidence.outcome])).toEqual([[`end:${attempt}`, 'failed']]);
    expect((await w.delivery(pr)).state).not.toBe('WORKING');
  });

  test('a late silent completion, after the task was claimed again: nothing moves, and the kernel hears nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/silent-late', files: { 'src/a.ts': 'export const a = 62;\n' } });
    const attempt = await silentAttempt(pr, 0);
    // The attempt's report is slow; meanwhile the task was requeued and claimed again.
    await q(sql`UPDATE workers SET created_at = now() - interval '5 minutes' WHERE id = ${attempt}::uuid`);
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
      VALUES (${w.workspaceId}::uuid, ${pr.ownerTaskId}::uuid, 'third', 'test', ${pr.branch}, 'running')`);
    await patchWorker(pr, attempt, silentBody, { outputRequirement: 'auto' });
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, retries: t.context?.silentCompletionRetryCount }).toEqual({ status: 'assigned', retries: 0 });
    expect(await transitions(pr, 'AttemptRequeued')).toEqual([]);
    expect(await transitions(pr, 'AttemptEnded')).toEqual([]);
  });

  test('a budget wall: pending through AttemptRequeued with its reset floor and flag', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/budget', files: { 'src/a.ts': 'export const a = 63;\n' } });
    await assigned(pr);
    const res = await patchWorker(pr, pr.workerId, { status: 'failed', error: 'Usage limit reached', budgetExhausted: true });
    expect(res.status).toBe(200);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedAt: t.claimed_at, flagged: t.context?.budgetExhausted }).toEqual({ status: 'pending', claimedAt: null, flagged: true });
    expect(t.start_at).not.toBeNull();
    const rq = await transitions(pr, 'AttemptRequeued');
    expect(rq.map((x) => [x.idempotency_key, x.evidence.reason])).toEqual([[`requeue:${pr.workerId}`, 'budget']]);
    expect((await w.delivery(pr)).state).toBe('WORKING');
  });

  test('an auth failover: pending on the other backend through AttemptRequeued', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/auth-failover', files: { 'src/a.ts': 'export const a = 64;\n' } });
    await assigned(pr);
    failoverTo = 'codex';
    const res = await patchWorker(pr, pr.workerId, { status: 'failed', error: 'Invalid API key' });
    expect(res.status).toBe(200);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, backend: t.backend, applied: t.context?.authFailoverApplied }).toEqual({ status: 'pending', backend: 'codex', applied: true });
    const rq = await transitions(pr, 'AttemptRequeued');
    expect(rq.map((x) => [x.idempotency_key, x.evidence.reason])).toEqual([[`requeue:${pr.workerId}`, 'auth_failover']]);
  });

  test('a late budget or auth report, after the task was claimed again: no fields, no status, no requeue', async () => {
    w = await world();
    const a = await w.openPr({ branch: 'feat/budget-late', files: { 'src/a.ts': 'export const a = 65;\n' } });
    await reclaim(a);
    await patchWorker(a, a.workerId, { status: 'failed', error: 'Usage limit reached', budgetExhausted: true });
    const ta = await taskRow(a.ownerTaskId);
    expect({ status: ta.status, flagged: ta.context?.budgetExhausted ?? null, startAt: ta.start_at }).toEqual({ status: 'assigned', flagged: null, startAt: null });
    expect(await transitions(a, 'AttemptRequeued')).toEqual([]);

    const b = await w.openPr({ branch: 'feat/auth-late', files: { 'src/b.ts': 'export const b = 65;\n' } });
    await reclaim(b);
    failoverTo = 'codex';
    await patchWorker(b, b.workerId, { status: 'failed', error: 'Invalid API key' });
    const tb = await taskRow(b.ownerTaskId);
    expect({ status: tb.status, backend: tb.backend === 'codex', applied: tb.context?.authFailoverApplied ?? null }).toEqual({ status: 'assigned', backend: false, applied: null });
    expect(await transitions(b, 'AttemptRequeued')).toEqual([]);
  });

  test('a credential hold (no other backend can carry it): pending behind its probe floor through AttemptRequeued; late, nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/cred-hold', files: { 'src/a.ts': 'export const a = 67;\n' } });
    await assigned(pr);
    const res = await patchWorker(pr, pr.workerId, { status: 'failed', error: 'Invalid API key' });
    expect(res.status).toBe(200);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedAt: t.claimed_at, held: !!t.context?.credentialHold }).toEqual({ status: 'pending', claimedAt: null, held: true });
    expect((await transitions(pr, 'AttemptRequeued')).map((x) => [x.idempotency_key, x.evidence.reason])).toEqual([[`requeue:${pr.workerId}`, 'credential_hold']]);

    const late = await w.openPr({ branch: 'feat/cred-hold-late', files: { 'src/b.ts': 'export const b = 67;\n' } });
    await reclaim(late);
    await patchWorker(late, late.workerId, { status: 'failed', error: 'Invalid API key' });
    const tl = await taskRow(late.ownerTaskId);
    expect({ status: tl.status, held: !!tl.context?.credentialHold }).toEqual({ status: 'assigned', held: false });
    expect(await transitions(late, 'AttemptRequeued')).toEqual([]);
  });

  test('a late completion report through the PATCH, after the task was claimed again: the new attempt keeps its task', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/late-complete', files: { 'src/a.ts': 'export const a = 66;\n' } });
    await reclaim(pr);
    const res = await patchWorker(pr, pr.workerId, { status: 'completed', summary: 'Pushed the change and opened the PR.', commitCount: 1, lastCommitSha: pr.head });
    expect(res.status).toBe(200);
    expect(await status(pr)).toBe('assigned');
  });
});

// ── The reaper ───────────────────────────────────────────────────────────────

describe('the reaper requeues a kernel owner through AttemptRequeued', () => {
  /** The owner attempt has run for a while and its runner went away; infra retries are left. */
  async function stalled(pr: OpenedPr, runner = 'test'): Promise<void> {
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() - interval '40 minutes',
        context = jsonb_build_object('infraRetryCount', 0) WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`UPDATE workers SET status = 'failed', runner = ${runner}, exit_cause = 'infra_failure', error = 'Worker runner went offline (heartbeat expired)',
        created_at = now() - interval '35 minutes', updated_at = now() WHERE id = ${pr.workerId}::uuid`);
  }
  function reap(pr: OpenedPr, o: { runner?: string; undelivered?: boolean } = {}) {
    return resolveTasksOfReapedWorkers([{
      id: pr.workerId, taskId: pr.ownerTaskId, prUrl: null, prNumber: null, commitCount: 0, branch: pr.branch,
      error: 'Worker runner went offline (heartbeat expired)', runner: o.runner ?? 'test',
    }], undefined, { undelivered: o.undelivered });
  }

  test('an infra requeue: pending with its backoff through the kernel, no end, the delivery still WORKING', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/reap-requeue', files: { 'src/a.ts': 'export const a = 70;\n' } });
    await stalled(pr);
    await reap(pr);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedAt: t.claimed_at, infra: t.context?.infraRetryCount }).toEqual({ status: 'pending', claimedAt: null, infra: 1 });
    expect(t.start_at).not.toBeNull();
    expect((await transitions(pr, 'AttemptRequeued')).map((x) => [x.idempotency_key, x.evidence.reason])).toEqual([[`requeue:${pr.workerId}`, 'infra_retry']]);
    expect(await transitions(pr, 'AttemptEnded')).toEqual([]);
    expect((await w.delivery(pr)).state).toBe('WORKING');
    // Reaped twice (two sweeps): the task is no longer open for that attempt, nothing more happens.
    await reap(pr);
    expect((await taskRow(pr.ownerTaskId)).context?.infraRetryCount).toBe(1);
    expect((await transitions(pr, 'AttemptRequeued')).length).toBe(1);
  });

  test('a late infra reap, after the task was claimed again: the new attempt keeps its task and its context', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/reap-requeue-late', files: { 'src/a.ts': 'export const a = 71;\n' } });
    await stalled(pr);
    // A re-claim in flight: claimed_at stamped after the reaped row, the new row not inserted yet.
    await q(sql`UPDATE tasks SET claimed_at = now() WHERE id = ${pr.ownerTaskId}::uuid`);
    await reap(pr);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, infra: t.context?.infraRetryCount }).toEqual({ status: 'assigned', infra: 0 });
    expect(await transitions(pr, 'AttemptRequeued')).toEqual([]);
  });

  test('a released interactive lease and an undelivered claim: pending through the kernel', async () => {
    w = await world();
    const a = await w.openPr({ branch: 'feat/reap-interactive', files: { 'src/a.ts': 'export const a = 72;\n' } });
    await stalled(a, 'mcp');
    await reap(a, { runner: 'mcp' });
    expect(await status(a)).toBe('pending');
    expect((await transitions(a, 'AttemptRequeued')).map((x) => x.evidence.reason)).toEqual(['interactive_release']);

    const b = await w.openPr({ branch: 'feat/reap-undelivered', files: { 'src/b.ts': 'export const b = 72;\n' } });
    await stalled(b);
    await reap(b, { undelivered: true });
    const tb = await taskRow(b.ownerTaskId);
    expect({ status: tb.status, lost: tb.context?.claimLostCount }).toEqual({ status: 'pending', lost: 1 });
    expect(tb.start_at).not.toBeNull();
    expect((await transitions(b, 'AttemptRequeued')).map((x) => x.evidence.reason)).toEqual(['claim_undelivered']);
  });

  test('a late interactive release, after the task was claimed again: nothing moves', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/reap-interactive-late', files: { 'src/a.ts': 'export const a = 73;\n' } });
    await stalled(pr, 'mcp');
    await q(sql`UPDATE tasks SET claimed_at = now() WHERE id = ${pr.ownerTaskId}::uuid`);
    await reap(pr, { runner: 'mcp' });
    expect(await status(pr)).toBe('assigned');
    expect(await transitions(pr, 'AttemptRequeued')).toEqual([]);
  });

  test('"Release slot" on an interactive session: pending through the kernel; a released session that is no longer the attempt moves nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/detach', files: { 'src/a.ts': 'export const a = 76;\n' } });
    await assigned(pr);
    await q(sql`UPDATE workers SET runner = 'mcp', created_at = now() - interval '4 minutes' WHERE id = ${pr.workerId}::uuid`);
    expect(await detachInteractiveWorker({ workerId: pr.workerId, actor: { kind: 'system' } as never, reason: 'test release' })).toMatchObject({ detached: true });
    expect(await status(pr)).toBe('pending');
    expect((await transitions(pr, 'AttemptRequeued')).map((x) => x.evidence.reason)).toEqual(['interactive_release']);

    const late = await w.openPr({ branch: 'feat/detach-late', files: { 'src/b.ts': 'export const b = 76;\n' } });
    await q(sql`UPDATE workers SET runner = 'mcp' WHERE id = ${late.workerId}::uuid`);
    await reclaim(late);
    expect(await detachInteractiveWorker({ workerId: late.workerId, actor: { kind: 'system' } as never, reason: 'test release' })).toMatchObject({ detached: true });
    // While WORKING the reducer records the old attempt's requeue (its own key); the guard keeps the new attempt's task.
    expect(await status(late)).toBe('assigned');
  });

  test('an expired loop wait never fails a kernel owner: its wait ends with its delivery', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/reap-loop-wait', files: { 'src/a.ts': 'export const a = 74;\n' } });
    await q(sql`UPDATE tasks SET status = 'pending', loop_state = 'condition_unmet', updated_at = now() - interval '10 hours',
        loop_config = ${JSON.stringify({ exitCondition: { type: 'pr_merged' }, maxLoops: 3, waitExpiryMinutes: 60 })}::jsonb
      WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`UPDATE workers SET status = 'failed' WHERE id = ${pr.workerId}::uuid`);
    await reap(pr);
    expect(await status(pr)).toBe('pending');
    expect(await w.commands(pr)).not.toContain('AttemptEnded');
  });

  test('a reviewer round the reaper times out fails the reviewer task, and the kernel hears it; the owner task is untouched', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/reap-reviewer', files: { 'src/a.ts': 'export const a = 75;\n' } });
    await w.handOn(pr);
    const rv = await w.reviewer(pr);
    await q(sql`UPDATE tasks SET status = 'assigned', category = 'review', claimed_at = now() - interval '40 minutes' WHERE id = ${rv.id}::uuid`);
    const [rw] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, created_at)
      VALUES (${w.workspaceId}::uuid, ${rv.id}::uuid, 'rv', 'test', ${pr.branch}, 'failed', now() - interval '35 minutes') RETURNING id`);
    await resolveTasksOfReapedWorkers([{ id: rw.id, taskId: rv.id, prUrl: null, prNumber: null, commitCount: 0, branch: pr.branch, error: 'stale', runner: 'test' }], 'timeout' as never);
    expect(await w.taskStatus(rv.id)).toBe('failed');
    expect(await w.commands(pr)).toContain('ReviewRoundFailed');
    expect(await status(pr)).toBe('completed');
  });
});

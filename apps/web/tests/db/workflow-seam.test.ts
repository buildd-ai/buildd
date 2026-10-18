/**
 * The live fix-loop seam against real Postgres (docs/specs/workflow-state-kernel.md
 * §13, §16: S1–S8, S25, plus the §14 cutover and kill switch). These drive the
 * functions the routes call (seam.ts) end to end through the real CAS
 * statements; only GitHub and the effect handlers' task creation are faked,
 * because the decision under test is the kernel's, not the reviewer prompt's.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { applyCommand, loadView } from '../../src/lib/workflow/kernel';
import { runEffects, type EffectHandler } from '../../src/lib/workflow/effects';
import type { GithubFactReader } from '../../src/lib/workflow/facts';
import type { LivePr } from '../../src/lib/workflow/commands';
import {
  adoptReviewVerdict,
  attemptEnded,
  claimFix,
  observeCiFailure,
  observeCiGreen,
  kernelDeliveryOfPr,
  fixCompletionGate,
  observeHead,
  observePrState,
  openKernelDelivery,
  recordReviewVerdict,
  requestReview,
  type SeamDeps,
} from '../../src/lib/workflow/seam';
import { kernelDeliveryForPr } from '../../src/lib/workflow/authority';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const REPO = 'acme/widgets';
let workspaceId: string;
let prSeq = 500;

/** The fake GitHub: one PR whose head, state and ancestry a test moves. */
interface FakePr { head: string; state: 'open' | 'closed'; merged: boolean; updatedAt: string; ancestors: Record<string, string[]>; equivalent?: Array<[string, string]> }
let gh: FakePr;
const live = (): LivePr => ({ state: gh.state, merged: gh.merged, headSha: gh.head, headRepoFullName: REPO, baseRef: 'dev', updatedAt: gh.updatedAt, mergedAt: gh.merged ? '2026-10-06T00:00:00Z' : null });
let checks: { complete: boolean; failing: string[] } | null = null;
let green: boolean | null = null;
const reader: GithubFactReader = {
  readPr: async () => live(),
  checkRuns: async () => checks,
  ciGreen: async () => green,
  contains: async (_repo, ancestor, head) => ancestor === head || (gh.ancestors[head] ?? []).includes(ancestor),
  contentEquivalent: async (_repo, _base, from, to) => (gh.equivalent ?? []).some(([f, t]) => f === from && t === to),
};

/** What the fake handlers dispatched, in order. */
let dispatched: Array<{ kind: string; taskId: string; round?: number; head?: string; attemptNo?: number }>;
let posted: Array<{ commitId: string; event: string }>;

const testHandlers: Record<string, EffectHandler> = {
  dispatch_review: async (e) => {
    const roundId = String(e.payload.roundId);
    const taskId = await seedTask(workspaceId, { status: 'pending', title: `review r${e.payload.round}` });
    await q(sql`UPDATE tasks SET delivery_id = ${e.deliveryId}::uuid, delivery_role = 'review', category = 'review',
      context = jsonb_build_object('workflowRoundId', ${roundId}::text, 'headSha', ${String(e.payload.headSha)}::text) WHERE id = ${taskId}::uuid`);
    await q(sql`UPDATE workflow_review_rounds SET reviewer_task_id = ${taskId}::uuid WHERE id = ${roundId}::uuid AND reviewer_task_id IS NULL`);
    dispatched.push({ kind: 'review', taskId, round: Number(e.payload.round), head: String(e.payload.headSha) });
  },
  dispatch_fix: async (e) => {
    const view = await loadView({ deliveryId: e.deliveryId });
    const taskId = await seedTask(workspaceId, { status: 'pending', title: 'fix' });
    const res = await applyCommand({
      type: 'FixDispatched', actor: 'kernel', roundId: String(e.payload.roundId), taskId, maxAttempts: view.delivery!.maxRounds,
      revalidation: { live: live(), newerApprove: false },
    }, { ref: { deliveryId: e.deliveryId } });
    if (res.result !== 'applied') return { outcome: `skipped:${res.reason}` };
    const attemptId = (res.decision.attempts.find((a) => a.op === 'insert') as { id: string }).id;
    await q(sql`UPDATE tasks SET delivery_id = ${e.deliveryId}::uuid, delivery_role = 'fix',
      context = jsonb_build_object('workflowAttemptId', ${attemptId}::text) WHERE id = ${taskId}::uuid`);
    dispatched.push({ kind: 'fix', taskId, attemptNo: Number(e.payload.attemptNo) });
  },
  post_review: async (e) => { posted.push({ commitId: String(e.payload.commitId), event: String(e.payload.event) }); },
};
const ok: EffectHandler = async () => ({ outcome: 'ok' });
const deps: SeamDeps = {
  reader: () => reader,
  repoFor: async () => ({ installationId: 1, repoFullName: REPO, gitConfig: null }),
  drain: async (deliveryId) => runEffects({
    deliveryId,
    handlers: new Proxy(testHandlers, { get: (t, k: string) => t[k] ?? ok }) as never,
  }),
};

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});
beforeEach(() => {
  gh = { head: 'H1', state: 'open', merged: false, updatedAt: 'u0', ancestors: {} };
  checks = null;
  green = null;
  dispatched = [];
  posted = [];
});

async function seedWorker(taskId: string, o: { status: string; lastCommitSha?: string | null; prNumber?: number }) {
  const [w] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w', 'test', 'feat/x', ${o.status}, ${o.lastCommitSha ?? null}, ${o.prNumber ?? null}) RETURNING id`);
  return w.id;
}

async function setKernel(on: boolean | null) {
  await q(sql`UPDATE workspaces SET git_config = ${on === null ? null : JSON.stringify({ workflowKernel: on })}::jsonb WHERE id = ${workspaceId}::uuid`);
}

/** A PR opened after cutover whose owner attempt ended: AWAITING_REVIEW, round 1 dispatched. */
async function openAndHandOn() {
  const ownerTaskId = await seedTask(workspaceId, { status: 'in_progress' });
  const prNumber = prSeq++;
  const opened = await openKernelDelivery({ workspaceId, ownerTaskId, repoFullName: REPO, prNumber, installationId: 1, source: 'webhook:opened' }, deps);
  expect(opened.owned).toBe(true);
  const workerId = await seedWorker(ownerTaskId, { status: 'completed', lastCommitSha: 'H1', prNumber });
  const ended = await attemptEnded({
    task: { id: ownerTaskId, workspaceId, deliveryId: opened.deliveryId!, deliveryRole: 'owner', context: null },
    workerId, status: 'completed', localHeadSha: 'H1', commitCount: 1, source: 'runner',
  }, deps);
  expect(ended.handled).toBe(true);
  const review = dispatched.find((x) => x.kind === 'review')!;
  return { ownerTaskId, prNumber, deliveryId: opened.deliveryId!, review };
}

const reviewerTask = async (taskId: string) => {
  const [t] = await q<{ id: string; delivery_id: string; context: Record<string, unknown> }>(sql`SELECT id, delivery_id, context FROM tasks WHERE id = ${taskId}::uuid`);
  return { id: t.id, deliveryId: t.delivery_id, context: t.context };
};
const fixTask = async (taskId: string) => {
  const [t] = await q<{ id: string; delivery_id: string; delivery_role: string; context: Record<string, unknown>; status: string }>(sql`SELECT id, delivery_id, delivery_role, context, status FROM tasks WHERE id = ${taskId}::uuid`);
  return { id: t.id, workspaceId, deliveryId: t.delivery_id, deliveryRole: t.delivery_role, context: t.context, status: t.status };
};
const rounds = (deliveryId: string) => q<{ round: number; head_sha: string; status: string; kind: string; verdict: string | null }>(
  sql`SELECT round, head_sha, status, kind, verdict FROM workflow_review_rounds WHERE delivery_id = ${deliveryId}::uuid ORDER BY round`);

async function requestChanges(deliveryId: string, review: { taskId: string; head?: string }) {
  return recordReviewVerdict({ reviewerTask: await reviewerTask(review.taskId), verdict: 'request-changes', effectiveVerdict: 'request-changes', headSha: review.head ?? gh.head, confidence: 0.9 }, deps);
}

describe('S1 — a fix that never pushed (#3754)', () => {
  test('the completion gate refuses, the worker-gone path is AWAITING_PUSH, and no second round is queued', async () => {
    const { deliveryId, review } = await openAndHandOn();
    expect((await loadView({ deliveryId })).delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 1, currentHeadSha: 'H1' });
    expect(review).toMatchObject({ round: 1, head: 'H1' });

    const v = await requestChanges(deliveryId, review);
    expect(v).toMatchObject({ handled: true, toState: 'CHANGES_REQUESTED' });
    expect(posted).toEqual([{ commitId: 'H1', event: 'REQUEST_CHANGES' }]);
    const fix = dispatched.find((x) => x.kind === 'fix')!;
    expect(fix.attemptNo).toBe(1);

    const t = await fixTask(fix.taskId);
    expect(await claimFix(t, deps)).toEqual({ action: 'proceed' });
    expect((await loadView({ deliveryId })).delivery!.state).toBe('FIXING');

    // The worker committed L2 locally and reports success; GitHub still has H1.
    const refusal = await fixCompletionGate({ task: t, localHeadSha: 'L2' }, deps);
    expect(refusal).toMatchObject({ code: 'delivery_not_advanced', boundHeadSha: 'H1', liveHeadSha: 'H1', localHeadSha: 'L2' });

    // Worker gone (the attempt ends anyway): AWAITING_PUSH + push_recovery, never AWAITING_REVIEW.
    const workerId = await seedWorker(fix.taskId, { status: 'completed', lastCommitSha: 'L2' });
    await attemptEnded({ task: t, workerId, status: 'completed', localHeadSha: 'L2', commitCount: 1, source: 'runner' }, deps);
    const after = await loadView({ deliveryId });
    expect(after.delivery!.state).toBe('AWAITING_PUSH');
    expect(after.attempts.find((a) => a.family === 'review_fix')).toMatchObject({ status: 'ended', outcome: 'unproven' });
    const fx = await q<{ kind: string }>(sql`SELECT kind FROM workflow_effects WHERE delivery_id = ${deliveryId}::uuid AND kind = 'push_recovery'`);
    expect(fx.length).toBe(1);

    // "Re-reviewing after fix 1" against H1 is not reachable.
    const again = await requestReview({ workspaceId, repoFullName: REPO, prNumber: (await loadView({ deliveryId })).delivery!.prNumber!, installationId: 1, forced: false, actor: 'kernel' }, deps);
    expect(again).toMatchObject({ handled: true, result: { result: 'rejected', reason: 'state_not_allowed' } });
    expect((await rounds(deliveryId)).length).toBe(1);
    expect(dispatched.filter((x) => x.kind === 'review').length).toBe(1);
  });

  test('a fix that pushed: the gate passes and the delivery goes back to review on the new head (delta round 2)', async () => {
    const { deliveryId, prNumber, review } = await openAndHandOn();
    await requestChanges(deliveryId, review);
    const fix = dispatched.find((x) => x.kind === 'fix')!;
    const t = await fixTask(fix.taskId);
    await claimFix(t, deps);

    gh.head = 'L2'; gh.ancestors.L2 = ['H1'];
    expect(await observeHead({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, hintedHeadSha: 'L2', source: 'webhook:synchronize' }, deps)).toBe(true);
    // Mid-fix push: recorded as the attempt's provenance, state stays FIXING.
    const mid = await loadView({ deliveryId });
    expect(mid.delivery).toMatchObject({ state: 'FIXING', currentHeadSha: 'L2' });
    expect(mid.attempts[0].reportedShas).toContain('L2');

    expect(await fixCompletionGate({ task: t, localHeadSha: 'L2' }, deps)).toBeNull();
    const workerId = await seedWorker(fix.taskId, { status: 'completed', lastCommitSha: 'L2' });
    await attemptEnded({ task: t, workerId, status: 'completed', localHeadSha: 'L2', commitCount: 1, source: 'runner' }, deps);
    const after = await loadView({ deliveryId });
    expect(after.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: 'L2' });
    expect((await rounds(deliveryId)).map((r) => [r.round, r.head_sha, r.kind])).toEqual([[1, 'H1', 'full'], [2, 'L2', 'delta']]);
    expect(after.attempts[0]).toMatchObject({ outcome: 'delivered' });
  });
});

describe('S2/S3 — a push under an approval', () => {
  async function approved() {
    const o = await openAndHandOn();
    const v = await recordReviewVerdict({ reviewerTask: await reviewerTask(o.review.taskId), verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 0.95 }, deps);
    expect(v).toMatchObject({ handled: true, toState: 'APPROVED' });
    return o;
  }

  test('S2: a non-equivalent push dispatches a delta round on the push, not at merge time', async () => {
    const { deliveryId, prNumber } = await approved();
    gh.head = 'H2';
    await observeHead({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, hintedHeadSha: 'H2', source: 'webhook:synchronize' }, deps);
    expect((await loadView({ deliveryId })).delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: 'H2' });
    expect(dispatched.filter((x) => x.kind === 'review').map((x) => x.head)).toEqual(['H1', 'H2']);
  });

  test('S3: a content-equivalent push carries the approval forward exactly once, even when observed twice concurrently', async () => {
    const { deliveryId, prNumber } = await approved();
    gh.head = 'H2';
    gh.equivalent = [['H1', 'H2']];
    const obs = () => observeHead({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, hintedHeadSha: 'H2', source: 'webhook:synchronize' }, deps);
    await Promise.all([obs(), obs()]);
    const d = (await loadView({ deliveryId })).delivery!;
    expect(d).toMatchObject({ state: 'APPROVED', currentHeadSha: 'H2' });
    expect(d.approvedHeads).toEqual(['H1', 'H2']);
    expect(dispatched.filter((x) => x.kind === 'review').length).toBe(1);
  });
});

describe('request_pr_review answers from rounds (task 1ebce52a)', () => {
  test('the reviewer named is the round\'s at the live head, never the newest reviewer row of the PR', async () => {
    const { prNumber, review } = await openAndHandOn();
    // A newer reviewer row for the same PR number that is not this delivery's.
    const other = await seedTask(workspaceId, { status: 'completed', title: 'legacy review' });
    await q(sql`UPDATE tasks SET category = 'review',
      context = jsonb_build_object('prNumber', ${prNumber}::int, 'headSha', 'HX') WHERE id = ${other}::uuid`);
    const r = await requestReview({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, forced: false, actor: 'agent:test' }, deps);
    expect(r).toMatchObject({ handled: true, result: { result: 'rejected', reason: 'review_in_flight' }, reviewTaskId: review.taskId });
  });
});

describe('S4/S5 — late and duplicate verdicts', () => {
  test('S4: a verdict for a superseded head is kept on its round and does nothing else', async () => {
    const { deliveryId, prNumber, review } = await openAndHandOn();
    gh.head = 'H2';
    await observeHead({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, hintedHeadSha: 'H2', source: 'webhook:synchronize' }, deps);
    const late = await recordReviewVerdict({ reviewerTask: await reviewerTask(review.taskId), verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 0.99 }, deps);
    expect(late).toMatchObject({ handled: true, toState: null, result: { result: 'stale' } });
    expect(posted).toEqual([]);
    const d = (await loadView({ deliveryId })).delivery!;
    expect(d).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2, approvedHeads: [] });
    expect((await rounds(deliveryId))[0]).toMatchObject({ round: 1, status: 'superseded', verdict: 'approve' });
  });

  test('S5: a replayed reviewer PATCH is a duplicate and doubles no effect', async () => {
    const { deliveryId, review } = await openAndHandOn();
    await requestChanges(deliveryId, review);
    const replay = await requestChanges(deliveryId, review);
    expect(replay).toMatchObject({ handled: true, result: { result: 'duplicate' } });
    expect(dispatched.filter((x) => x.kind === 'fix').length).toBe(1);
    expect(posted.length).toBe(1);
  });
});

describe('S7/S8/S25 — fix dispatch races, budget, claim-time revalidation', () => {
  test('S7: two concurrent dispatch_fix deliveries allocate one attempt', async () => {
    const { deliveryId, review } = await openAndHandOn();
    // Record the verdict without draining, then race two drains.
    const view = await loadView({ deliveryId });
    const r1 = view.rounds[0];
    await applyCommand({ type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: r1.id, verdict: 'request_changes', effectiveVerdict: 'request_changes', headBound: 'H1' }, { ref: { deliveryId } });
    void review;
    await Promise.all([deps.drain!(deliveryId), deps.drain!(deliveryId)]);
    const after = await loadView({ deliveryId });
    expect(after.attempts.filter((a) => a.family === 'review_fix').length).toBe(1);
  });

  test('S8: request-changes at the last round escalates once', async () => {
    const ownerTaskId = await seedTask(workspaceId, { status: 'in_progress' });
    const prNumber = prSeq++;
    const opened = await openKernelDelivery({ workspaceId, ownerTaskId, repoFullName: REPO, prNumber, installationId: 1, source: 'test' }, deps);
    await q(sql`UPDATE workflow_deliveries SET max_rounds = 1 WHERE id = ${opened.deliveryId!}::uuid`);
    const workerId = await seedWorker(ownerTaskId, { status: 'completed', lastCommitSha: 'H1', prNumber });
    await attemptEnded({ task: { id: ownerTaskId, workspaceId, deliveryId: opened.deliveryId!, deliveryRole: 'owner', context: null }, workerId, status: 'completed', localHeadSha: 'H1', commitCount: 1, source: 'runner' }, deps);
    const review = dispatched.find((x) => x.kind === 'review')!;
    const v = await requestChanges(opened.deliveryId!, review);
    expect(v).toMatchObject({ toState: 'ESCALATED' });
    const d = (await loadView({ deliveryId: opened.deliveryId! })).delivery!;
    expect(d.stateReason).toBe('review_exhausted');
    const ex = await q(sql`SELECT 1 FROM workflow_effects WHERE delivery_id = ${opened.deliveryId!}::uuid AND kind = 'escalate_exhaustion'`);
    expect(ex.length).toBe(1);
    expect(dispatched.filter((x) => x.kind === 'fix').length).toBe(0);
  });

  test('S19: a fix worker the reaper lost re-dispatches the next attempt (never "completed" with local commits)', async () => {
    const { deliveryId, review } = await openAndHandOn();
    await requestChanges(deliveryId, review);
    const fix = dispatched.find((x) => x.kind === 'fix')!;
    const t = await fixTask(fix.taskId);
    await claimFix(t, deps);
    const workerId = await seedWorker(fix.taskId, { status: 'failed' });
    await attemptEnded({ task: t, workerId, status: 'lost', localHeadSha: null, commitCount: 2, source: 'sweep:stale-workers' }, deps);
    const after = await loadView({ deliveryId });
    expect(after.delivery!.state).toBe('CHANGES_REQUESTED');
    const fixes = after.attempts.filter((a) => a.family === 'review_fix').sort((a, b) => a.attemptNo - b.attemptNo);
    // AC-19: the PR head never moved: "no change", and it counted.
    expect(fixes.map((a) => [a.attemptNo, a.status, a.outcome])).toEqual([[1, 'ended', 'noop'], [2, 'queued', null]]);
    expect(dispatched.filter((x) => x.kind === 'fix').length).toBe(2);
  });

  test('S25: a fix whose PR was approved while it queued is skipped at claim, not started', async () => {
    const { deliveryId, review } = await openAndHandOn();
    await requestChanges(deliveryId, review);
    const fix = dispatched.find((x) => x.kind === 'fix')!;
    // A newer push moved the head before any worker claimed the fix.
    gh.head = 'H9';
    const decision = await claimFix(await fixTask(fix.taskId), deps);
    expect(decision).toEqual({ action: 'cancel', reason: 'fix_not_needed' });
    const a = (await loadView({ deliveryId })).attempts.find((x) => x.family === 'review_fix')!;
    expect(a.status).toBe('skipped');
  });
});

describe('§14 cutover and the kill switch', () => {
  test('kernelDeliveryOfPr names the owning delivery and its state; a legacy PR or a released delivery is null (task 3f57afd0)', async () => {
    const { prNumber, deliveryId } = await openAndHandOn();
    expect(await kernelDeliveryOfPr({ workspaceId, prNumber }, deps)).toMatchObject({ deliveryId, state: 'AWAITING_REVIEW' });
    expect(await kernelDeliveryOfPr({ workspaceId, prNumber: prSeq++ }, deps)).toBeNull();
    await q(sql`UPDATE workflow_deliveries SET authority = 'legacy' WHERE id = ${deliveryId}::uuid`);
    expect(await kernelDeliveryOfPr({ workspaceId, prNumber }, deps)).toBeNull();
  });


  test('a PR open at cutover (no delivery) stays legacy everywhere', async () => {
    const prNumber = prSeq++;
    expect(await kernelDeliveryForPr(workspaceId, REPO, prNumber)).toBeNull();
    expect(await observeHead({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, hintedHeadSha: 'X', source: 'webhook:synchronize' }, deps)).toBe(false);
    expect(await observePrState({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, source: 'webhook:closed' }, deps)).toBe(false);
    // A mid-review legacy reviewer task (no delivery) is not a kernel round.
    const legacyReviewer = await seedTask(workspaceId, { status: 'in_progress' });
    expect(await recordReviewVerdict({ reviewerTask: await reviewerTask(legacyReviewer), verdict: 'approve', effectiveVerdict: 'approve', headSha: 'X', confidence: 1 }, deps)).toEqual({ handled: false });
    expect(await requestReview({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, forced: false, actor: 'kernel' }, deps)).toEqual({ handled: false });
  });

  test('the owner attempt ended before the PR webhook: opening hands the delivery on at once', async () => {
    const ownerTaskId = await seedTask(workspaceId, { status: 'completed' });
    const prNumber = prSeq++;
    await seedWorker(ownerTaskId, { status: 'completed', lastCommitSha: 'H1', prNumber });
    const opened = await openKernelDelivery({ workspaceId, ownerTaskId, repoFullName: REPO, prNumber, installationId: 1, source: 'webhook:opened' }, deps);
    expect(opened.owned).toBe(true);
    expect((await loadView({ deliveryId: opened.deliveryId! })).delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 1 });
    // Both doors (create_pr and webhook) may open it: the second is a no-op.
    expect(await openKernelDelivery({ workspaceId, ownerTaskId, repoFullName: REPO, prNumber, installationId: 1, source: 'create_pr' }, deps)).toEqual({ owned: true, deliveryId: opened.deliveryId });
    expect(dispatched.filter((x) => x.kind === 'review').length).toBe(1);
  });

  test('switch off: a mid-review delivery is released to legacy, stays legacy when switched back on, and no new delivery opens while off', async () => {
    const { deliveryId, prNumber, review } = await openAndHandOn();
    await setKernel(false);
    try {
      expect(await kernelDeliveryForPr(workspaceId, REPO, prNumber)).toBeNull();
      const [row] = await q<{ authority: string; released_at: string | null }>(sql`SELECT authority, released_at FROM workflow_deliveries WHERE id = ${deliveryId}::uuid`);
      expect(row.authority).toBe('legacy');
      expect(row.released_at).not.toBeNull();
      // The legacy path now owns the verdict of the in-flight round.
      expect(await recordReviewVerdict({ reviewerTask: await reviewerTask(review.taskId), verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 1 }, deps)).toEqual({ handled: false });
      const other = await seedTask(workspaceId, { status: 'in_progress' });
      expect(await openKernelDelivery({ workspaceId, ownerTaskId: other, repoFullName: REPO, prNumber: prSeq++, installationId: 1, source: 'test' }, deps)).toMatchObject({ owned: false, reason: 'kernel_off' });
    } finally {
      await setKernel(null);
    }
    // Sticky: back on, the released delivery is still legacy (legacy may have acted on it meanwhile).
    expect(await kernelDeliveryForPr(workspaceId, REPO, prNumber)).toBeNull();
    // Kernel state was not touched by the release.
    expect((await loadView({ deliveryId })).delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 1 });
  });

  test('switch off → on: a PR opened after the switch is back on is kernel-owned (task 57e1d5b8)', async () => {
    const offTask = await seedTask(workspaceId, { status: 'in_progress' });
    const offPr = prSeq++;
    await setKernel(false);
    try {
      expect(await openKernelDelivery({ workspaceId, ownerTaskId: offTask, repoFullName: REPO, prNumber: offPr, installationId: 1, source: 'webhook:opened' }, deps))
        .toMatchObject({ owned: false, reason: 'kernel_off' });
    } finally {
      await setKernel(true);
    }
    try {
      // The PR the switch refused while off stays legacy: no delivery was opened for it.
      expect(await kernelDeliveryForPr(workspaceId, REPO, offPr)).toBeNull();
      // A new PR opened after the switch is back on is the kernel's, end to end.
      const ownerTaskId = await seedTask(workspaceId, { status: 'in_progress' });
      const prNumber = prSeq++;
      const opened = await openKernelDelivery({ workspaceId, ownerTaskId, repoFullName: REPO, prNumber, installationId: 1, source: 'webhook:opened' }, deps);
      expect(opened.owned).toBe(true);
      expect(opened.deliveryId).toBeTruthy();
      expect(await kernelDeliveryForPr(workspaceId, REPO, prNumber)).not.toBeNull();
      const [row] = await q<{ authority: string; released_at: string | null }>(sql`SELECT authority, released_at FROM workflow_deliveries WHERE id = ${opened.deliveryId!}::uuid`);
      expect(row).toMatchObject({ authority: 'kernel', released_at: null });
      const workerId = await seedWorker(ownerTaskId, { status: 'completed', lastCommitSha: 'H1', prNumber });
      const ended = await attemptEnded({
        task: { id: ownerTaskId, workspaceId, deliveryId: opened.deliveryId!, deliveryRole: 'owner', context: null },
        workerId, status: 'completed', localHeadSha: 'H1', commitCount: 1, source: 'runner',
      }, deps);
      expect(ended.handled).toBe(true);
      expect((await loadView({ deliveryId: opened.deliveryId! })).delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 1 });
    } finally {
      await setKernel(null);
    }
  });

  test('closed and reopened PRs: T17 is terminal, a later push is ignored', async () => {
    const { deliveryId, prNumber } = await openAndHandOn();
    gh.state = 'closed'; gh.merged = true;
    expect(await observePrState({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, source: 'webhook:closed' }, deps)).toBe(true);
    expect((await loadView({ deliveryId })).delivery!.state).toBe('MERGED');
    gh.state = 'open'; gh.merged = false; gh.head = 'H5';
    await observeHead({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, hintedHeadSha: 'H5', source: 'webhook:synchronize' }, deps);
    expect((await loadView({ deliveryId })).delivery).toMatchObject({ state: 'MERGED', currentHeadSha: 'H1' });
  });
});

describe('S5: the review loop never stalls (workflow-kernel-library.md §5)', () => {
  test('1bd26ae7: a round whose dispatch filed no reviewer is re-armed when someone asks, and answers with the reviewer it filed', async () => {
    const { deliveryId, prNumber } = await openAndHandOn();
    // The dispatch ran and left no reviewer on the round (the stall seen on a single-PR delivery).
    await q(sql`UPDATE workflow_review_rounds SET reviewer_task_id = NULL WHERE delivery_id = ${deliveryId}::uuid`);
    dispatched = [];
    const r = await requestReview({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, forced: false, actor: 'agent:test' }, deps);
    expect(r).toMatchObject({ handled: true, result: { result: 'rejected', reason: 'review_in_flight' } });
    expect(dispatched.map((x) => x.kind)).toEqual(['review']);
    expect((r as { reviewTaskId: string | null }).reviewTaskId).toBe(dispatched[0]!.taskId);
    expect((await rounds(deliveryId)).length).toBe(1);
  });

  test('1bd26ae7: a fix that pushed from elsewhere (no local head reported) arms a delta re-review at the new head', async () => {
    const { deliveryId, review } = await openAndHandOn();
    await requestChanges(deliveryId, review);
    const fix = dispatched.find((x) => x.kind === 'fix')!;
    const t = await fixTask(fix.taskId);
    await claimFix(t, deps);
    gh.head = 'H2';
    gh.ancestors = { H2: ['H1'] };
    const workerId = await seedWorker(fix.taskId, { status: 'completed' });
    await attemptEnded({ task: t, workerId, status: 'completed', localHeadSha: null, commitCount: 0, source: 'runner' }, deps);
    const d = (await loadView({ deliveryId })).delivery!;
    expect(d).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H2' });
    expect((await rounds(deliveryId)).map((r) => [r.round, r.head_sha, r.kind, r.status])).toEqual([[1, 'H1', 'full', 'decided'], [2, 'H2', 'delta', 'queued']]);
    expect(dispatched.filter((x) => x.kind === 'review').map((x) => x.head)).toEqual(['H1', 'H2']);
  });

  test('a fix that rebased and force-pushed (new head does not descend from the bound head) arms the delta re-review at completion', async () => {
    const { deliveryId, review } = await openAndHandOn();
    await requestChanges(deliveryId, review);
    const fix = dispatched.find((x) => x.kind === 'fix')!;
    const t = await fixTask(fix.taskId);
    await claimFix(t, deps);
    gh.head = 'H2';
    gh.ancestors = {};
    const workerId = await seedWorker(fix.taskId, { status: 'completed' });
    await attemptEnded({ task: t, workerId, status: 'completed', localHeadSha: null, commitCount: 0, source: 'runner' }, deps);
    expect((await loadView({ deliveryId })).delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H2' });
    expect(dispatched.filter((x) => x.kind === 'review').map((x) => x.head)).toEqual(['H1', 'H2']);
  });

  test('00d288fd: a reviewer from outside the rounds approves while the owner works; the owner\'s end applies it, no second review', async () => {
    const ownerTaskId = await seedTask(workspaceId, { status: 'in_progress' });
    const prNumber = prSeq++;
    const opened = await openKernelDelivery({ workspaceId, ownerTaskId, repoFullName: REPO, prNumber, installationId: 1, source: 'webhook:opened' }, deps);
    const legacyReviewer = await seedTask(workspaceId, { status: 'completed', title: 'legacy review' });
    const kept = await adoptReviewVerdict({ deliveryId: opened.deliveryId!, reviewerTaskId: legacyReviewer, verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 0.9 }, deps);
    expect(kept).toMatchObject({ result: 'applied', decision: { toState: 'WORKING' } });
    expect(posted).toEqual([]);
    const workerId = await seedWorker(ownerTaskId, { status: 'completed', lastCommitSha: 'H1', prNumber });
    await attemptEnded({ task: { id: ownerTaskId, workspaceId, deliveryId: opened.deliveryId!, deliveryRole: 'owner', context: null }, workerId, status: 'completed', localHeadSha: 'H1', commitCount: 1, source: 'runner' }, deps);
    expect((await loadView({ deliveryId: opened.deliveryId! })).delivery).toMatchObject({ state: 'APPROVED', approvedHeads: ['H1'] });
    expect(dispatched.filter((x) => x.kind === 'review')).toEqual([]);
  });

  test('38442d17: a green re-run on the head CI repair was filed for returns the approved PR to APPROVED', async () => {
    const { deliveryId, prNumber, review } = await openAndHandOn();
    await recordReviewVerdict({ reviewerTask: await reviewerTask(review.taskId), verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 0.95 }, deps);
    await applyCommand({ type: 'CiFailedObserved', actor: 'webhook', headSha: 'H1', signature: 'ci:db', maxAttempts: 3 }, { ref: { deliveryId } });
    expect((await loadView({ deliveryId })).delivery!.state).toBe('REPAIRING');
    checks = { complete: false, failing: [] };
    await observeCiGreen({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, headSha: 'H1', source: 'webhook:check_suite' }, deps);
    expect((await loadView({ deliveryId })).delivery!.state).toBe('REPAIRING');
    // Every check run done, none failing, but a suite was cancelled: not green (38442d17 re-review).
    checks = { complete: true, failing: [] };
    green = false;
    await observeCiGreen({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, headSha: 'H1', source: 'webhook:check_suite' }, deps);
    expect((await loadView({ deliveryId })).delivery!.state).toBe('REPAIRING');
    green = true;
    const r = await observeCiGreen({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, headSha: 'H1', source: 'webhook:check_suite' }, deps);
    expect(r).toMatchObject({ handled: true, result: { result: 'applied', decision: { toState: 'APPROVED' } } });
    const v = await loadView({ deliveryId });
    expect(v.attempts.filter((a) => a.family === 'ci').map((a) => [a.status, a.outcome])).toEqual([['skipped', 'noop']]);
  });

  test('6900a317: outside a CI repair the head\'s reading is recorded, per head, without moving the delivery', async () => {
    const { deliveryId, prNumber } = await openAndHandOn();
    const at = { workspaceId, repoFullName: REPO, prNumber, installationId: 1, source: 'webhook:check_suite' };
    const d = async () => (await loadView({ deliveryId })).delivery!;
    checks = { complete: true, failing: [] };
    green = true;
    // A late green for an older head says nothing about this one.
    expect(await observeCiGreen({ ...at, headSha: 'H0' }, deps)).toEqual({ handled: true, result: null });
    expect(await d()).toMatchObject({ ci: null, ciHeadSha: null });
    const r = await observeCiGreen({ ...at, headSha: 'H1' }, deps);
    expect(r).toMatchObject({ handled: true, result: { result: 'applied', decision: { toState: 'AWAITING_REVIEW' } } });
    expect(await d()).toMatchObject({ state: 'AWAITING_REVIEW', ci: 'green', ciHeadSha: 'H1' });
    // A failing run on the head beats the runs still going.
    checks = { complete: false, failing: ['check'] };
    green = false;
    await observeCiGreen({ ...at, headSha: 'H1' }, deps);
    expect(await d()).toMatchObject({ state: 'AWAITING_REVIEW', ci: 'red', ciHeadSha: 'H1' });
    // It is re-run: nothing failing, not finished, so the head is being checked again.
    checks = { complete: false, failing: [] };
    await observeCiGreen({ ...at, headSha: 'H1' }, deps);
    expect(await d()).toMatchObject({ ci: null, ciHeadSha: null });
    // The failure hint for the superseded run arrives after the re-run passed: T10 refuses it, the green is recorded.
    checks = { complete: true, failing: [] };
    green = true;
    const seen = await observeCiFailure({ ...at, headSha: 'H1', signature: 'ci_failed', maxAttempts: 3 }, deps);
    expect(seen).toMatchObject({ handled: true, result: { result: 'rejected', reason: 'ci_not_red' } });
    expect(await d()).toMatchObject({ state: 'AWAITING_REVIEW', ci: 'green', ciHeadSha: 'H1' });
  });
});

describe('S5: a reviewer\'s deferral names its task by short id (workflow-kernel-library.md §5)', () => {
  test('a short id resolves to the workspace\'s task; one that resolves to nothing closes nothing, and the verdict still lands on its round', async () => {
    const { deliveryId, review } = await openAndHandOn();
    await recordReviewVerdict({ reviewerTask: await reviewerTask(review.taskId), verdict: 'request-changes', effectiveVerdict: 'request-changes', headSha: 'H1', confidence: 0.9,
      output: { findings: [{ path: 'a.ts', title: 'fix a' }, { path: 'b.ts', title: 'fix b' }] } }, deps);
    const fix = dispatched.find((x) => x.kind === 'fix')!;
    const t = await fixTask(fix.taskId);
    await claimFix(t, deps);
    gh.head = 'H2';
    gh.ancestors = { H2: ['H1'] };
    await attemptEnded({ task: t, workerId: await seedWorker(fix.taskId, { status: 'completed', lastCommitSha: 'H2' }), status: 'completed', localHeadSha: 'H2', commitCount: 1, source: 'runner' }, deps);
    const review2 = dispatched.filter((x) => x.kind === 'review').at(-1)!;
    const findings = (await loadView({ deliveryId })).findings!;
    const [a, b] = [findings.find((f) => f.path === 'a.ts')!.id, findings.find((f) => f.path === 'b.ts')!.id];
    const docs = await seedTask(workspaceId, { status: 'pending', title: 'docs slice' });
    const r = await recordReviewVerdict({ reviewerTask: await reviewerTask(review2.taskId), verdict: 'request-changes', effectiveVerdict: 'request-changes', headSha: 'H2', confidence: 0.9,
      output: { deferredFindings: [{ id: a, reason: 'docs slice', taskId: docs.slice(0, 8) }, { id: b, reason: 'later', taskId: 'ffffffff' }] } }, deps);
    expect(r).toMatchObject({ handled: true, result: { result: 'applied' }, toState: 'CHANGES_REQUESTED' });
    const after = (await loadView({ deliveryId })).findings!;
    expect(after.find((f) => f.id === a)).toMatchObject({ status: 'deferred', deferredToTaskId: docs });
    expect(after.find((f) => f.id === b)).toMatchObject({ status: 'open', deferredToTaskId: null });
    expect((await rounds(deliveryId)).map((x) => x.status)).toEqual(['decided', 'decided']);
  });

  test('a short id that prefixes two tasks resolves to neither; another workspace\'s task never resolves, by short id or full id', async () => {
    const { deliveryId, review } = await openAndHandOn();
    await recordReviewVerdict({ reviewerTask: await reviewerTask(review.taskId), verdict: 'request-changes', effectiveVerdict: 'request-changes', headSha: 'H1', confidence: 0.9,
      output: { findings: [{ path: 'a.ts', title: 'fix a' }, { path: 'b.ts', title: 'fix b' }, { path: 'c.ts', title: 'fix c' }] } }, deps);
    const fix = dispatched.find((x) => x.kind === 'fix')!;
    const t = await fixTask(fix.taskId);
    await claimFix(t, deps);
    gh.head = 'H2';
    gh.ancestors = { H2: ['H1'] };
    await attemptEnded({ task: t, workerId: await seedWorker(fix.taskId, { status: 'completed', lastCommitSha: 'H2' }), status: 'completed', localHeadSha: 'H2', commitCount: 1, source: 'runner' }, deps);
    const review2 = dispatched.filter((x) => x.kind === 'review').at(-1)!;
    const findings = (await loadView({ deliveryId })).findings!;
    const id = (path: string) => findings.find((f) => f.path === path)!.id;
    // Two tasks of this workspace sharing an 8-character prefix, and one task of another workspace.
    const prefix = Array.from({ length: 8 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    const full = (tail: string) => [prefix, '0000', '4000', '8000', tail].join('-');
    for (const tail of ['00000000000a', '00000000000b']) {
      await q(sql`INSERT INTO tasks (id, workspace_id, title, status) VALUES (${full(tail)}::uuid, ${workspaceId}::uuid, 'twin', 'pending')`);
    }
    const { workspaceId: other } = await seedWorkspace();
    const foreign = await seedTask(other, { title: 'another workspace' });
    const r = await recordReviewVerdict({ reviewerTask: await reviewerTask(review2.taskId), verdict: 'request-changes', effectiveVerdict: 'request-changes', headSha: 'H2', confidence: 0.9,
      output: { deferredFindings: [
        { id: id('a.ts'), reason: 'ambiguous', taskId: prefix },
        { id: id('b.ts'), reason: 'foreign by short id', taskId: foreign.slice(0, 8) },
        { id: id('c.ts'), reason: 'foreign by full id', taskId: foreign },
      ] } }, deps);
    expect(r).toMatchObject({ handled: true, result: { result: 'applied' }, toState: 'CHANGES_REQUESTED' });
    const after = (await loadView({ deliveryId })).findings!;
    for (const path of ['a.ts', 'b.ts', 'c.ts']) expect(after.find((f) => f.path === path)).toMatchObject({ status: 'open', deferredToTaskId: null });
    const ev = (r as { result: { decision: { evidence: { findings: { unresolvedDeferrals: Array<{ id: string }> } } } } }).result.decision.evidence.findings.unresolvedDeferrals;
    expect(ev.map((x) => x.id).sort()).toEqual([id('a.ts'), id('b.ts'), id('c.ts')].sort());
  });
});

describe('S5 re-review: unpushed commits are never delivery (AC-10)', () => {
  test('a fix that ended unproven with commits it never reported, while someone else pushed a descendant, waits for its push', async () => {
    const { deliveryId, review } = await openAndHandOn();
    await requestChanges(deliveryId, review);
    const fix = dispatched.find((x) => x.kind === 'fix')!;
    const t = await fixTask(fix.taskId);
    await claimFix(t, deps);
    gh.head = 'H2';
    gh.ancestors = { H2: ['H1'] };
    const workerId = await seedWorker(fix.taskId, { status: 'failed' });
    await attemptEnded({ task: t, workerId, status: 'unproven', localHeadSha: null, commitCount: 2, source: 'runner' }, deps);
    const d = (await loadView({ deliveryId })).delivery!;
    expect(d.state).not.toBe('AWAITING_REVIEW');
    expect(d.state).toBe('AWAITING_PUSH');
  });
});

describe('S5 re-review: the red-PR sweep ends a CI repair only on every check passing', () => {
  test('a cancelled re-run that leaves nothing failing does not cancel the CI fix', async () => {
    const { deliveryId, prNumber, review } = await openAndHandOn();
    await recordReviewVerdict({ reviewerTask: await reviewerTask(review.taskId), verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 0.95 }, deps);
    await applyCommand({ type: 'CiFailedObserved', actor: 'webhook', headSha: 'H1', signature: 'ci:db', maxAttempts: 3 }, { ref: { deliveryId } });
    checks = { complete: true, failing: [] };
    green = false;
    await observeCiFailure({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, headSha: 'H1', signature: 'ci:db', maxAttempts: 3, source: 'sweep:red-prs' }, deps);
    expect((await loadView({ deliveryId })).delivery!.state).toBe('REPAIRING');
    green = true;
    await observeCiFailure({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, headSha: 'H1', signature: 'ci:db', maxAttempts: 3, source: 'sweep:red-prs' }, deps);
    expect((await loadView({ deliveryId })).delivery!.state).toBe('APPROVED');
  });
});

describe('AC-79: a merge of the base while a review fix runs (workflow-kernel-library.md §5)', () => {
  const transitionsOf = (deliveryId: string) => q<{ command: string; to_state: string; evidence: Record<string, unknown> }>(
    sql`SELECT command, to_state, evidence FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid ORDER BY to_version`);
  const roundRows = (deliveryId: string) => q<{ round: number; head_sha: string; kind: string; status: string; scope: Record<string, unknown> | null }>(
    sql`SELECT round, head_sha, kind, status, scope FROM workflow_review_rounds WHERE delivery_id = ${deliveryId}::uuid ORDER BY round`);

  test('the base merge is recorded as a foreign push, the fix cannot complete on it, and a delta round scoped to the refresh is queued', async () => {
    const { deliveryId, prNumber, review } = await openAndHandOn();
    await requestChanges(deliveryId, review);
    const fix = dispatched.find((x) => x.kind === 'fix')!;
    const t = await fixTask(fix.taskId);
    await claimFix(t, deps);

    // GitHub's update-branch merges the base in: H2 descends from H1 and the PR's own diff is unchanged.
    gh.head = 'H2'; gh.ancestors = { H2: ['H1'] }; gh.equivalent = [['H1', 'H2']];
    expect(await observeHead({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, hintedHeadSha: 'H2', source: 'webhook:synchronize' }, deps)).toBe(true);
    const mid = await loadView({ deliveryId });
    expect(mid.delivery).toMatchObject({ state: 'FIXING', currentHeadSha: 'H2' });
    expect(mid.attempts.find((a) => a.family === 'review_fix')!.reportedShas).toEqual([]);
    const head = (await transitionsOf(deliveryId)).filter((x) => x.command === 'HeadObserved').at(-1)!;
    expect(head).toMatchObject({ to_state: 'FIXING', evidence: { foreignPush: true, baseOnly: 'compare' } });

    // The fix tries to complete on the base merge: refused, naming why.
    const refusal = await fixCompletionGate({ task: t, localHeadSha: null }, deps);
    expect(refusal).toMatchObject({ code: 'repair_base_only', boundHeadSha: 'H1', liveHeadSha: 'H2' });

    // Its worker ends anyway: no delivery of the fix, a round scoped to the refresh at H2.
    const workerId = await seedWorker(fix.taskId, { status: 'completed' });
    await attemptEnded({ task: t, workerId, status: 'completed', localHeadSha: null, commitCount: 0, source: 'runner' }, deps);
    const after = await loadView({ deliveryId });
    expect(after.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: 'H2', boundAttemptId: null });
    expect(after.attempts.find((a) => a.family === 'review_fix')).toMatchObject({ status: 'ended', outcome: 'noop' });
    const [, r2] = await roundRows(deliveryId);
    expect(r2).toMatchObject({ round: 2, head_sha: 'H2', kind: 'delta', status: 'queued' });
    expect(r2.scope).toMatchObject({ refresh: { fromHeadSha: 'H1', toHeadSha: 'H2' } });
    expect(after.rounds.at(-1)!.trigger).toBe('base_refresh');
  });

  test('a fix push followed by a base merge: only the fix push is credited and the fix completes on the merged head', async () => {
    const { deliveryId, prNumber, review } = await openAndHandOn();
    await requestChanges(deliveryId, review);
    const fix = dispatched.find((x) => x.kind === 'fix')!;
    const t = await fixTask(fix.taskId);
    await claimFix(t, deps);

    gh.head = 'L2'; gh.ancestors = { L2: ['H1'] };
    await observeHead({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, hintedHeadSha: 'L2', source: 'webhook:synchronize' }, deps);
    gh.head = 'H3'; gh.ancestors = { L2: ['H1'], H3: ['L2', 'H1'] }; gh.equivalent = [['L2', 'H3']];
    await observeHead({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, hintedHeadSha: 'H3', source: 'webhook:synchronize' }, deps);
    expect((await loadView({ deliveryId })).attempts.find((a) => a.family === 'review_fix')!.reportedShas).toEqual(['L2']);
    expect((await transitionsOf(deliveryId)).filter((x) => x.command === 'HeadObserved').at(-1)!.evidence).toMatchObject({ foreignPush: true, baseOnly: 'compare' });

    expect(await fixCompletionGate({ task: t, localHeadSha: 'L2' }, deps)).toBeNull();
    const workerId = await seedWorker(fix.taskId, { status: 'completed', lastCommitSha: 'L2' });
    await attemptEnded({ task: t, workerId, status: 'completed', localHeadSha: 'L2', commitCount: 1, source: 'runner' }, deps);
    const after = await loadView({ deliveryId });
    expect(after.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: 'H3' });
    expect(after.attempts.find((a) => a.family === 'review_fix')).toMatchObject({ outcome: 'delivered' });
    expect(after.rounds.at(-1)!.trigger).toBe('changes_requested_fix');
  });
});

describe('S5 part 3: a verified no-op through the seam (§13.13 rule 4)', () => {
  test('a fix that pushed nothing and claims, with evidence, that an open finding is already fixed ends "no change" and owes a verification round at the same head', async () => {
    const { deliveryId, review } = await openAndHandOn();
    await recordReviewVerdict({ reviewerTask: await reviewerTask(review.taskId), verdict: 'request-changes', effectiveVerdict: 'request-changes', headSha: 'H1', confidence: 0.9,
      output: { findings: [{ path: 'src/a.ts', title: 'guard the null' }] } }, deps);
    const fix = dispatched.find((x) => x.kind === 'fix')!;
    const t = await fixTask(fix.taskId);
    await claimFix(t, deps);
    const id = (await loadView({ deliveryId })).findings![0]!.id;
    const workerId = await seedWorker(fix.taskId, { status: 'completed' });
    await attemptEnded({ task: t, workerId, status: 'completed', localHeadSha: null, commitCount: 0, source: 'runner', noopEvidence: { findingIds: [id], evidence: 'src/a.ts already returns early on null' } }, deps);
    const v = await loadView({ deliveryId });
    expect(v.delivery!.state).toBe('AWAITING_REVIEW');
    expect(v.attempts.find((a) => a.family === 'review_fix')!.outcome).toBe('noop');
    expect((await rounds(deliveryId)).map((r) => [r.round, r.head_sha, r.status])).toEqual([[1, 'H1', 'decided'], [2, 'H1', 'queued']]);
    expect(v.findings![0]!.status).toBe('open');
  });
});

describe('38442d17: a CI repair that ended without a push while its head reads green', () => {
  /** An approved PR whose CI failed at H1: REPAIRING, with the CI attempt's task filed as the dispatch handler would. */
  async function repairingWithCiTask() {
    const { deliveryId, prNumber, review } = await openAndHandOn();
    await recordReviewVerdict({ reviewerTask: await reviewerTask(review.taskId), verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 0.95 }, deps);
    await applyCommand({ type: 'CiFailedObserved', actor: 'webhook', headSha: 'H1', signature: 'ci:db', maxAttempts: 3 }, { ref: { deliveryId } });
    const view = await loadView({ deliveryId });
    expect(view.delivery!.state).toBe('REPAIRING');
    const attempt = view.attempts.find((a) => a.family === 'ci')!;
    const taskId = await seedTask(workspaceId, { status: 'pending', title: 'ci fix' });
    await q(sql`UPDATE tasks SET delivery_id = ${deliveryId}::uuid, delivery_role = 'ci_fix',
      context = jsonb_build_object('workflowAttemptId', ${attempt.id}::text) WHERE id = ${taskId}::uuid`);
    const task = await fixTask(taskId);
    const workerId = await seedWorker(taskId, { status: 'failed', prNumber });
    return { deliveryId, task, workerId };
  }
  const ciAttempts = async (deliveryId: string) => (await loadView({ deliveryId })).attempts.filter((a) => a.family === 'ci');

  test('a cancelled (lost) repair on the bound head, now green, resumes the delivery and queues no further fix', async () => {
    const { deliveryId, task, workerId } = await repairingWithCiTask();
    checks = { complete: true, failing: [] };
    green = true;
    const r = await attemptEnded({ task, workerId, status: 'lost', localHeadSha: null, commitCount: 0, source: 'sweep:cancelled' }, deps);
    expect(r).toMatchObject({ handled: true, result: { result: 'applied', decision: { toState: 'APPROVED' } } });
    expect((await loadView({ deliveryId })).delivery!.state).toBe('APPROVED');
    expect((await ciAttempts(deliveryId)).length).toBe(1);
  });

  test.each([
    ['ciGreen false', () => { gh.head = 'H1'; green = false; }],
    ['ciGreen unknown', () => { gh.head = 'H1'; green = null; }],
    ['a different live head', () => { gh.head = 'H2'; gh.ancestors = { H2: ['H1'] }; green = true; }],
  ])('%s falls through to the retry ledger', async (_name, arrange) => {
    const { deliveryId, task, workerId } = await repairingWithCiTask();
    checks = { complete: true, failing: [] };
    arrange();
    await attemptEnded({ task, workerId, status: 'lost', localHeadSha: null, commitCount: 0, source: 'sweep:cancelled' }, deps);
    expect((await loadView({ deliveryId })).delivery!.state).not.toBe('APPROVED');
    expect((await ciAttempts(deliveryId)).length).toBeGreaterThan(1);
  });

  test('a completed repair does not take the branch, even on a green head', async () => {
    const { deliveryId, task, workerId } = await repairingWithCiTask();
    checks = { complete: true, failing: [] };
    green = true;
    await attemptEnded({ task, workerId, status: 'completed', localHeadSha: null, commitCount: 0, source: 'runner' }, deps);
    expect((await loadView({ deliveryId })).delivery!.state).not.toBe('APPROVED');
  });
});

/**
 * Workflow state kernel against real Postgres
 * (docs/specs/workflow-state-kernel.md §7, AC-4, AC-6). The CAS guard, the
 * all-or-nothing CTE chain and idempotent replay live in SQL a mocked `db`
 * cannot observe, so they are proved here.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { applyCommand, loadView, transitionSql } from '../../src/lib/workflow/kernel';
import { ingestFact, type GithubFactReader } from '../../src/lib/workflow/facts';
import { reduce } from '../../src/lib/workflow/reducer';
import { runEffects } from '../../src/lib/workflow/effects';
import type { LivePr } from '../../src/lib/workflow/commands';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

const REPO = 'acme/widgets';
let prSeq = 100;
const live = (headSha: string, extra: Partial<LivePr> = {}): LivePr => ({
  state: 'open', merged: false, headSha, headRepoFullName: REPO, baseRef: 'dev', ...extra,
});
const reader = (pr: () => LivePr | null): GithubFactReader => ({ readPr: async () => pr() });

async function openDelivery(): Promise<{ taskId: string; deliveryId: string; prNumber: number }> {
  const taskId = await seedTask(workspaceId, { status: 'in_progress' });
  const prNumber = prSeq++;
  const opened = await ingestFact({ kind: 'delivery_opened', workspaceId, source: 'runner', ownerTaskId: taskId, requiresPr: true });
  expect(opened.result).toBe('applied');
  const bound = await ingestFact(
    { kind: 'pr_bound', workspaceId, source: 'runner', repoFullName: REPO, prNumber, ownerTaskId: taskId },
    { github: reader(() => live('h0')) },
  );
  expect(bound.result).toBe('applied');
  return { taskId, deliveryId: (opened as { deliveryId: string }).deliveryId, prNumber };
}

const transitions = (deliveryId: string) => q<{ command: string; from_version: number; to_version: number; to_state: string; idempotency_key: string }>(
  sql`SELECT command, from_version, to_version, to_state, idempotency_key FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid ORDER BY to_version`,
);
const effects = (deliveryId: string) => q<{ kind: string; dedupe_key: string; status: string }>(
  sql`SELECT kind, dedupe_key, status FROM workflow_effects WHERE delivery_id = ${deliveryId}::uuid ORDER BY created_at, kind`,
);

describe('opening and binding a delivery', () => {
  test('DeliveryOpened + PrBound + HeadObserved write one versioned transition each', async () => {
    const { deliveryId, prNumber } = await openDelivery();
    const head = await ingestFact(
      { kind: 'head_observed', workspaceId, source: 'webhook:synchronize', repoFullName: REPO, prNumber, hintedHeadSha: 'stale-payload-head' },
      { github: reader(() => live('h1')) },
    );
    expect(head.result).toBe('applied');
    const view = await loadView({ deliveryId });
    // R2: the live head, not the payload head.
    expect(view.delivery).toMatchObject({ state: 'WORKING', version: 3, currentHeadSha: 'h1', repoFullName: REPO, prNumber });
    const log = await transitions(deliveryId);
    expect(log.map((t) => [t.command, Number(t.from_version), Number(t.to_version)])).toEqual([
      ['DeliveryOpened', 0, 1], ['PrBound', 1, 2], ['HeadObserved', 2, 3],
    ]);
    const facts = await q<{ kind: string; applied_transition_id: string | null; delivery_id: string | null }>(
      sql`SELECT kind, applied_transition_id, delivery_id FROM workflow_facts WHERE delivery_id = ${deliveryId}::uuid ORDER BY observed_at`,
    );
    expect(facts.map((f) => f.kind)).toEqual(['delivery_opened', 'pr_bound', 'head_observed']);
    expect(facts.every((f) => f.applied_transition_id)).toBe(true);
  });

  test('a duplicate fact is a no-op returning the first application', async () => {
    const { deliveryId, prNumber } = await openDelivery();
    const f = { kind: 'head_observed' as const, workspaceId, source: 'webhook:synchronize', repoFullName: REPO, prNumber };
    const first = await ingestFact(f, { github: reader(() => live('h1')) });
    const again = await ingestFact(f, { github: reader(() => live('h1')) });
    expect(first.result).toBe('applied');
    expect(again).toMatchObject({ result: 'duplicate', firstSeen: false, transitionId: (first as { transitionId: string }).transitionId });
    expect((await transitions(deliveryId)).length).toBe(3);
  });

  test('opening the same task twice returns the existing delivery', async () => {
    const taskId = await seedTask(workspaceId);
    const cmd = { type: 'DeliveryOpened' as const, actor: 'runner', workspaceId, ownerTaskId: taskId, requiresPr: true };
    const [a, b] = await Promise.all([applyCommand(cmd), applyCommand(cmd)]);
    expect([a.result, b.result].sort()).toEqual(['applied', 'duplicate']);
    const rows = await q(sql`SELECT id FROM workflow_deliveries WHERE owner_task_id = ${taskId}::uuid`);
    expect(rows).toHaveLength(1);
  });
});

describe('CAS (AC-4) and atomic effects (AC-6)', () => {
  test('two writers at the same version: exactly one applies, the other is stale', async () => {
    const { deliveryId } = await openDelivery();
    const view = await loadView({ deliveryId });
    const a = reduce(view, { type: 'HeadObserved', actor: 'webhook', live: live('hA') });
    const b = reduce(view, { type: 'HeadObserved', actor: 'webhook', live: live('hB') });
    if (a.result !== 'apply' || b.result !== 'apply') throw new Error('expected apply');
    const [ra, rb] = await Promise.all([
      q(transitionSql(a, { deliveryId })),
      q(transitionSql(b, { deliveryId })),
    ]);
    expect(ra.length + rb.length).toBe(1);
    const after = await loadView({ deliveryId });
    expect(after.delivery!.version).toBe(view.delivery!.version + 1);
  });

  test('a CAS miss writes no transition and no effect', async () => {
    const { deliveryId } = await openDelivery();
    const view = await loadView({ deliveryId });
    const d = reduce(view, { type: 'ReviewRequested', actor: 'human:x', headSha: 'h0', live: live('h0') });
    // h0 was never observed as the head, so this is rejected; build an apply by hand from a moved view instead.
    expect(d.result).toBe('rejected');
    await applyCommand({ type: 'HeadObserved', actor: 'webhook', live: live('h1') }, { ref: { deliveryId } });
    const staleView = view; // version 2, now 3 in the database
    const decision = reduce(staleView, { type: 'HeadObserved', actor: 'webhook', live: live('h9') });
    if (decision.result !== 'apply') throw new Error('expected apply');
    const before = (await effects(deliveryId)).length;
    expect(await q(transitionSql(decision, { deliveryId }))).toHaveLength(0);
    expect((await effects(deliveryId)).length).toBe(before);
    expect((await transitions(deliveryId)).map((t) => t.idempotency_key).some((k) => k.endsWith(':h9'))).toBe(false);
  });

  test('applyCommand re-reads once after a CAS miss and decides against the new state', async () => {
    const { deliveryId } = await openDelivery();
    await applyCommand({ type: 'HeadObserved', actor: 'webhook', live: live('h1') }, { ref: { deliveryId } });
    // Attempt ends with the live head containing it: a review round is queued in the same statement.
    const { taskId } = { taskId: (await loadView({ deliveryId })).delivery!.ownerTaskId };
    const ended = await applyCommand(
      { type: 'AttemptEnded', actor: 'runner', workerId: crypto.randomUUID(), taskId, outcome: 'success', localHeadSha: 'h1', commitCount: 1, live: live('h1') },
      { ref: { deliveryId } },
    );
    expect(ended.result).toBe('applied');
    const view = await loadView({ deliveryId });
    expect(view.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 1 });
    expect(view.rounds).toHaveLength(1);
    expect(view.rounds[0]).toMatchObject({ round: 1, headSha: 'h1', status: 'queued', kind: 'full' });
    const fx = await effects(deliveryId);
    expect(fx.filter((e) => e.kind === 'dispatch_review')).toHaveLength(1);
  });

  test('a replayed idempotency key is a duplicate; nothing is written twice', async () => {
    const { deliveryId, taskId } = await openDelivery();
    const workerId = crypto.randomUUID();
    const cmd = { type: 'AttemptEnded' as const, actor: 'runner', workerId, taskId, outcome: 'success' as const, localHeadSha: 'L1', commitCount: 1, live: live('h0') };
    const first = await applyCommand(cmd, { ref: { deliveryId } });
    expect(first.result).toBe('applied');
    expect((await loadView({ deliveryId })).delivery!.state).toBe('AWAITING_PUSH');
    const replay = await applyCommand(cmd, { ref: { deliveryId } });
    expect(replay).toMatchObject({ result: 'duplicate', transitionId: (first as { transitionId: string }).transitionId });
    expect((await effects(deliveryId)).filter((e) => e.kind === 'push_recovery')).toHaveLength(1);
  });
});

describe('the #3754 fix loop end to end', () => {
  test('a fix that never pushed cannot reach AWAITING_REVIEW; the stale re-review is rejected', async () => {
    const { deliveryId, taskId } = await openDelivery();
    await applyCommand({ type: 'HeadObserved', actor: 'webhook', live: live('H1') }, { ref: { deliveryId } });
    await applyCommand({ type: 'AttemptEnded', actor: 'runner', workerId: crypto.randomUUID(), taskId, outcome: 'success', localHeadSha: 'H1', commitCount: 1, live: live('H1') }, { ref: { deliveryId } });
    let view = await loadView({ deliveryId });
    const round1 = view.rounds[0];
    expect(round1.headSha).toBe('H1');

    const verdict = await applyCommand({ type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: round1.id, verdict: 'request_changes', effectiveVerdict: 'request_changes', headBound: 'H1' }, { ref: { deliveryId } });
    expect(verdict.result).toBe('applied');
    const fixTask = await seedTask(workspaceId);
    const dispatched = await applyCommand({ type: 'FixDispatched', actor: 'kernel', roundId: round1.id, taskId: fixTask, maxAttempts: 3, revalidation: { live: live('H1'), newerApprove: false } }, { ref: { deliveryId } });
    expect(dispatched.result).toBe('applied');
    view = await loadView({ deliveryId });
    const attempt = view.attempts[0];
    expect(attempt).toMatchObject({ family: 'review_fix', attemptNo: 1, status: 'queued', taskId: fixTask });

    // Racing duplicate dispatch for the same round (#3420): no second ledger row.
    const again = await applyCommand({ type: 'FixDispatched', actor: 'kernel', roundId: round1.id, taskId: fixTask, maxAttempts: 3, revalidation: { live: live('H1'), newerApprove: false } }, { ref: { deliveryId } });
    expect(again.result).toBe('duplicate');

    expect((await applyCommand({ type: 'FixClaimed', actor: 'runner', attemptId: attempt.id, revalidation: { live: live('H1'), approved: false } }, { ref: { deliveryId } })).result).toBe('applied');
    const ended = await applyCommand({ type: 'AttemptEnded', actor: 'runner', workerId: crypto.randomUUID(), attemptId: attempt.id, outcome: 'success', localHeadSha: 'L2', commitCount: 1, live: live('H1') }, { ref: { deliveryId } });
    expect(ended.result).toBe('applied');
    view = await loadView({ deliveryId });
    expect(view.delivery!.state).toBe('AWAITING_PUSH');
    expect(view.rounds).toHaveLength(1);
    expect(view.attempts[0]).toMatchObject({ status: 'ended', outcome: 'unproven' });
    expect(view.attempts[0].reportedShas).toEqual(['L2']);

    const reReview = await applyCommand({ type: 'ReviewRequested', actor: 'kernel', headSha: 'H1', live: live('H1') }, { ref: { deliveryId } });
    expect(reReview).toMatchObject({ result: 'rejected', reason: 'state_not_allowed' });

    // Push recovery lands L2: proof holds, round 2 (delta) bound to L2.
    const pushed = await applyCommand({ type: 'HeadObserved', actor: 'webhook', live: live('L2') }, { ref: { deliveryId } });
    expect(pushed.result).toBe('applied');
    view = await loadView({ deliveryId });
    expect(view.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: 'L2' });
    expect(view.rounds.map((r) => [r.round, r.headSha, r.kind, r.status])).toEqual([[1, 'H1', 'full', 'decided'], [2, 'L2', 'delta', 'queued']]);
    expect(view.attempts[0]).toMatchObject({ outcome: 'delivered' });
  });

  test('a late verdict for a superseded round is kept for audit, never applied', async () => {
    const { deliveryId, taskId } = await openDelivery();
    await applyCommand({ type: 'HeadObserved', actor: 'webhook', live: live('A1') }, { ref: { deliveryId } });
    await applyCommand({ type: 'AttemptEnded', actor: 'runner', workerId: crypto.randomUUID(), taskId, outcome: 'success', localHeadSha: 'A1', commitCount: 1, live: live('A1') }, { ref: { deliveryId } });
    const r1 = (await loadView({ deliveryId })).rounds[0];
    await applyCommand({ type: 'HeadObserved', actor: 'webhook', live: live('A2') }, { ref: { deliveryId } });
    const late = await applyCommand({ type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: r1.id, verdict: 'approve', effectiveVerdict: 'approve', headBound: 'A1' }, { ref: { deliveryId } });
    expect(late.result).toBe('stale');
    const view = await loadView({ deliveryId });
    expect(view.delivery!.state).toBe('AWAITING_REVIEW');
    expect(view.delivery!.approvedHeads).toEqual([]);
    expect(view.rounds.find((r) => r.id === r1.id)).toMatchObject({ status: 'superseded', verdict: 'approve' });
    expect((await effects(deliveryId)).some((e) => e.kind === 'post_review')).toBe(false);
  });
});

describe('effect drain', () => {
  test('claims, runs and acks; a superseded gated effect is skipped', async () => {
    const { deliveryId, taskId } = await openDelivery();
    await applyCommand({ type: 'AttemptEnded', actor: 'runner', workerId: crypto.randomUUID(), taskId, outcome: 'success', localHeadSha: 'Z1', commitCount: 1, live: live('h0') }, { ref: { deliveryId } });
    // push_recovery is delayed by its backoff; make it due now.
    await q(sql`UPDATE workflow_effects SET not_before = now() WHERE delivery_id = ${deliveryId}::uuid`);
    // Move the delivery on so the queued push_recovery no longer describes it.
    await applyCommand({ type: 'PushRecoveryExhausted', actor: 'kernel', localHeadSha: 'Z1' }, { ref: { deliveryId } });
    const ran: string[] = [];
    let summary = { claimed: 0, done: 0, skipped: 0, failed: 0, dead: [] as unknown[] };
    for (let i = 0; i < 5; i++) {
      const s = await runEffects({ limit: 50, handlers: { render_activity: async (e) => { if (e.deliveryId === deliveryId) ran.push(e.kind); }, notify: async () => {}, push_recovery: async () => { throw new Error('must not run'); } } });
      summary = { ...summary, claimed: summary.claimed + s.claimed, skipped: summary.skipped + s.skipped };
      if (s.claimed === 0) break;
    }
    const fx = await effects(deliveryId);
    expect(fx.find((e) => e.kind === 'push_recovery')).toMatchObject({ status: 'done' });
    const outcome = await q<{ outcome: string }>(sql`SELECT outcome FROM workflow_effects WHERE delivery_id = ${deliveryId}::uuid AND kind = 'push_recovery'`);
    expect(outcome[0].outcome).toBe('skipped:superseded');
    expect(ran.length).toBeGreaterThan(0);
  }, 60_000);
});

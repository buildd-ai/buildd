/**
 * A second occurrence after a person resolves (task 10658a4c). A person takes
 * an escalation back to the same head; the same thing then happens again. Each
 * test proves the second occurrence is decided as a new event, not dropped as
 * a replay of the first, and that a true replay still is a duplicate. The real
 * kernel on real Postgres against the stateful fake GitHub; see
 * workflow-scenarios-world.ts. The test name is the sequence and the outcome.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';
import { seam, world, type World } from './workflow-scenarios-world';
import { applyCommand } from '../../src/lib/workflow/kernel';

let w: World;
afterEach(() => w?.dispose());

type Pr = Awaited<ReturnType<World['openPr']>>;

/** A person dismisses the escalation they are looking at (T23 dismiss → a full round at the head). */
async function dismiss(w: World, pr: Pr) {
  const d = await w.delivery(pr);
  const r = await applyCommand(
    { type: 'HumanResolve', actor: 'human:owner', choice: 'dismiss', reason: 'checked by hand', expectedVersion: d.version },
    { ref: { deliveryId: pr.deliveryId } },
  );
  expect(r.result).toBe('applied');
  await seam.drainDelivery(pr.deliveryId);
  await w.deliver();
}

/** Time passes: every pending effect of the delivery comes due and the drain runs it. Once. */
async function tick(pr: Pr): Promise<void> {
  await q(sql`UPDATE workflow_effects SET not_before = now() - interval '1 second' WHERE delivery_id = ${pr.deliveryId}::uuid AND status = 'pending'`);
  await seam.drainDelivery(pr.deliveryId);
}

const finding = { outcome: 'human' as const, reason: 'deny path touched', destructive: false };
const importFinding = (w: World, pr: Pr) => seam.recordPolicyEvidence({
  workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId, source: 'webhook:opened', finding,
});

describe('a policy finding (T28)', () => {
  test('escalated, a person dismisses it, the same finding is imported again → their call stands; the base is retargeted (the finding is dropped) and it is imported again → ESCALATED(policy_human) again', async () => {
    w = await world();
    w.gh.createBranch(w.repo, 'staging', 'dev');
    await w.deliver();
    const pr = await w.openPr({ branch: 'feat/policy-repeat', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    expect((await importFinding(w, pr))?.result).toBe('applied');
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'policy_human' });

    await dismiss(w, pr);
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_REVIEW' });
    // A redelivered webhook (or the other door) brings the same finding: a duplicate.
    expect((await importFinding(w, pr))?.result).toBe('duplicate');
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_REVIEW' });

    // The PR moves to another base: the reviews and the finding no longer describe its diff.
    await w.gh.request('PATCH', `/repos/${w.repo}/pulls/${pr.prNumber}`, { base: 'staging' });
    await w.deliver();
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_REVIEW', baseRef: 'staging', policyEvidence: null });

    const again = await importFinding(w, pr);
    expect(again?.result).toBe('applied');
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'policy_human' });
  });
});

describe('review budget exhaustion (T6/T7)', () => {
  test('request_changes at the last round → ESCALATED(review_exhausted); a person dismisses; request_changes again at the same head → ESCALATED again and the person is told twice', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/exhaust-repeat', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await q(sql`UPDATE workflow_deliveries SET max_rounds = 1 WHERE id = ${pr.deliveryId}::uuid`);
    await w.handOn(pr);
    await w.verdict(pr, await w.reviewer(pr), 'request_changes', pr.head);
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_exhausted' });

    await dismiss(w, pr);
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: pr.head });
    await w.verdict(pr, await w.reviewer(pr), 'request_changes', pr.head);
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_exhausted' });
    expect((await w.effects(pr)).filter((e) => e.kind === 'escalate_exhaustion')).toHaveLength(2);
  });
});

describe('push recovery (T22)', () => {
  test('the owner ends with an unpushed L → ESCALATED(push_undeliverable); a person dismisses; the fix ends with the same L unpushed → AWAITING_PUSH runs its own recovery and escalates again', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/push-repeat', files: { 'src/a.ts': 'export const a = 2;\n' } });
    const unpushed = 'f'.repeat(40);
    await q(sql`UPDATE workers SET status = 'completed' WHERE id = ${pr.workerId}::uuid`);
    await seam.attemptEnded({
      task: { id: pr.ownerTaskId, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null },
      workerId: pr.workerId, status: 'completed', localHeadSha: unpushed, commitCount: 1, source: 'runner',
    });
    for (let i = 0; i < 5 && (await w.delivery(pr)).state === 'AWAITING_PUSH'; i++) await tick(pr);
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'push_undeliverable' });

    await dismiss(w, pr);
    await w.verdict(pr, await w.reviewer(pr), 'request_changes', pr.head);
    const [t] = await w.tasksOf(pr, 'fix');
    const fix = { id: t.id, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'fix', context: t.context };
    expect(await seam.claimFix(fix)).toEqual({ action: 'proceed' });
    const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, commit_count)
      VALUES (${w.workspaceId}::uuid, ${fix.id}::uuid, 'wk', 'test', ${pr.branch}, 'completed', ${unpushed}, 1) RETURNING id`);
    await seam.attemptEnded({ task: fix, workerId: wk.id, status: 'completed', localHeadSha: unpushed, commitCount: 1, source: 'runner' });
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_PUSH' });
    // The second visit owns its next move: a recovery try is queued, not swallowed by the first chain's keys.
    expect((await w.effects(pr)).filter((e) => e.kind === 'push_recovery' && e.status === 'pending')).toHaveLength(1);

    for (let i = 0; i < 5 && (await w.delivery(pr)).state === 'AWAITING_PUSH'; i++) await tick(pr);
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'push_undeliverable' });
    expect((await w.commands(pr)).filter((c) => c === 'PushRecoveryExhausted')).toHaveLength(2);
    expect((await w.effects(pr)).filter((e) => e.kind === 'notify' && e.dedupe_key.includes(':pushdead:'))).toHaveLength(2);
  });
});

describe('a dead review dispatch (T22b)', () => {
  test('the dispatch_review effect goes dead → ESCALATED(review_unavailable); an agent asks for the review again → AWAITING_REVIEW with a fresh round', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/dead-dispatch', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    const [eff] = await q<{ id: string; dedupe_key: string }>(sql`SELECT id, dedupe_key FROM workflow_effects WHERE delivery_id = ${pr.deliveryId}::uuid AND kind = 'dispatch_review' ORDER BY created_at DESC LIMIT 1`);
    const dead = await applyCommand(
      { type: 'EffectDead', actor: 'kernel', effectId: eff.id, effectKind: 'dispatch_review', dedupeKey: eff.dedupe_key, lastError: 'no reviewer could be asked' },
      { ref: { deliveryId: pr.deliveryId } },
    );
    expect(dead.result).toBe('applied');
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_unavailable' });

    const r = await seam.requestReview({ workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId, forced: false, actor: 'agent:organizer' });
    expect(r.handled && r.result.result).toBe('applied');
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2 });
  });
});

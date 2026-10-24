/**
 * Living Spec r7 §7, kernel half (task 59f2c591), on real Postgres and the stateful fake GitHub:
 *
 * - AC-44: once the review budget is spent, a pushed fix marks its finding addressed, awaiting
 *   verification; the hold stays through green CI and nothing reviews, fixes or merges on its own.
 * - AC-45: a person's forced review and bounded fix are each one kernel command bound to the head
 *   they decided on; the same decision again is answered by the first and files nothing.
 * - AC-46: a decision for a head that moved, or one an agent makes, is refused and moves nothing.
 * - AC-47: the read model counts each finding once.
 * - Approve and override (follow-up 22): a person with merge permission, under a policy that
 *   allows it, approves the head past its findings once; Buildd / Review approval turns success
 *   for that head and it lands once. A stale head, an agent, no merge permission or a policy
 *   that does not allow it are refused and move nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { seam, world, type World } from './workflow-scenarios-world';
import { q } from './harness';
import { deriveDeliveryView } from '../../src/lib/workflow/projections';

let w: World;
afterEach(() => w?.dispose());

type Pr = Awaited<ReturnType<World['openPr']>>;

/** A PR whose one-round review budget a request for changes spent, with findings on src/a.ts and src/b.ts. */
async function exhausted(w: World): Promise<Pr> {
  const pr = await w.openPr({ branch: `feat/r7-${Math.random().toString(36).slice(2, 7)}`, files: { 'src/a.ts': 'export const a = 2;\n', 'src/b.ts': 'export const b = 2;\n' } });
  await q(sql`UPDATE workflow_deliveries SET max_rounds = 1 WHERE id = ${pr.deliveryId}::uuid`);
  await w.handOn(pr);
  const rv = await w.reviewer(pr);
  const r = await seam.recordReviewVerdict({
    reviewerTask: { id: rv.id, deliveryId: pr.deliveryId, context: rv.context }, verdict: 'request_changes', effectiveVerdict: 'request_changes',
    headSha: pr.head, confidence: 0.9, output: { findings: [{ path: 'src/a.ts', title: 'fix a' }, { path: 'src/b.ts', title: 'fix b' }] },
  });
  expect(r.handled && r.result.result).toBe('applied');
  await w.deliver();
  expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_exhausted' });
  return pr;
}

/** The owner pushes a fix to src/a.ts only; returns the new head. */
async function pushFixToA(w: World, pr: Pr): Promise<string> {
  const head = w.gh.push(w.repo, pr.branch, { 'src/a.ts': 'export const a = 3;\n' }, { message: 'fix a' });
  await w.deliver();
  return head;
}

const statesOf = async (w: World, pr: Pr) => Object.fromEntries(((await w.view(pr)).findings ?? []).map((f) => [f.path, f.status]));
const forced = (w: World, pr: Pr, actor: string, decision: { headSha: string; version: number }) => seam.requestReview({
  workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId, forced: true, actor, decision,
});

describe('r7 §7: findings after a spent review budget, and a person\'s decisions on it', () => {
  test('AC-44 / AC-47: a pushed fix is addressed, awaiting verification; green CI and a landing request leave the hold', async () => {
    w = await world();
    const pr = await exhausted(w);
    const h2 = await pushFixToA(w, pr);
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_exhausted', currentHeadSha: h2, currentRound: 1 });
    expect(await statesOf(w, pr)).toEqual({ 'src/a.ts': 'addressed', 'src/b.ts': 'open' });

    w.gh.greenCi(w.repo, h2, ['build', 'test']);
    await w.deliver();
    await w.land(pr, h2);
    await w.deliver();
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_exhausted' });
    expect(w.mergeCalls(pr)).toHaveLength(0);
    expect(await w.tasksOf(pr, 'review')).toHaveLength(1);
    expect(await w.tasksOf(pr, 'fix')).toHaveLength(0);

    const v = deriveDeliveryView({ view: await w.view(pr) })!;
    expect(v.findingTotals).toEqual({ open: 1, addressedAwaitingVerification: 1, verifiedResolved: 0, waived: 0, deferred: 0, total: 2, advisory: 0 });
    expect(v.escalation?.findings.addressedAwaitingVerification.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(v.escalation?.decisionHead).toEqual({ headSha: h2, version: v.version });
  }, 60_000);

  test('AC-45 / AC-46: a stale or agent decision is refused; a person\'s forced review and bounded fix run once each', async () => {
    w = await world();
    const pr = await exhausted(w);
    const h2 = await pushFixToA(w, pr);
    const v1 = (await w.delivery(pr)).version;

    // AC-46: decided on the head before the push, or by an agent: refused, nothing filed.
    const stale = await forced(w, pr, 'human:u1', { headSha: pr.head, version: v1 });
    expect(stale.handled && stale.result).toMatchObject({ result: 'rejected', reason: 'decision_head_stale' });
    const agent = await forced(w, pr, 'agent:t9', { headSha: h2, version: v1 });
    expect(agent.handled && agent.result).toMatchObject({ result: 'rejected', reason: 'human_required' });
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', version: v1 });
    expect(await w.tasksOf(pr, 'review')).toHaveLength(1);

    // AC-45: the person's forced review at the current head; the same decision again changes nothing.
    const first = await forced(w, pr, 'human:u1', { headSha: h2, version: v1 });
    expect(first.handled && first.result.result).toBe('applied');
    const again = await forced(w, pr, 'human:u1', { headSha: h2, version: v1 });
    expect(again.handled && again.result).toMatchObject({ result: 'duplicate', reason: 'idempotency_key_seen' });
    expect(await w.tasksOf(pr, 'review')).toHaveLength(2);
    const [audit] = await q<{ bypass: Record<string, unknown> }>(sql`
      SELECT bypass FROM workflow_transitions WHERE delivery_id = ${pr.deliveryId}::uuid AND command = 'ReviewRequested' ORDER BY to_version DESC LIMIT 1`);
    expect(audit.bypass).toMatchObject({ forced: true, actor: 'human:u1', headSha: h2 });

    // The forced review verifies the push to a and keeps b open: past the budget, a person's again.
    const findings = (await w.view(pr)).findings ?? [];
    const a = findings.find((f) => f.path === 'src/a.ts')!.id;
    const b = findings.find((f) => f.path === 'src/b.ts')!.id;
    const rv = await w.reviewer(pr);
    await seam.recordReviewVerdict({
      reviewerTask: { id: rv.id, deliveryId: pr.deliveryId, context: rv.context }, verdict: 'request_changes', effectiveVerdict: 'request_changes',
      headSha: h2, confidence: 0.9, output: { resolvedFindings: [a], findings: [{ id: b, path: 'src/b.ts', title: 'fix b' }] },
    });
    await w.deliver();
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_exhausted' });
    expect(await statesOf(w, pr)).toEqual({ 'src/a.ts': 'resolved', 'src/b.ts': 'open' });
    expect(deriveDeliveryView({ view: await w.view(pr) })!.findingTotals).toMatchObject({ open: 1, addressedAwaitingVerification: 0, verifiedResolved: 1, total: 2 });

    // AC-45: one bounded fix at the head; replayed, it is the same fix.
    const v2 = (await w.delivery(pr)).version;
    const fix = () => seam.applyRecommendationThroughKernel({ workspaceId: w.workspaceId, prNumber: pr.prNumber, actor: 'human:u1', expectedVersion: v2, decisionHeadSha: h2 });
    const f1 = await fix();
    expect(f1?.result.result).toBe('applied');
    expect(f1?.attempt?.taskId).toBeTruthy();
    const f2 = await fix();
    expect(f2?.result).toMatchObject({ result: 'duplicate', reason: 'idempotency_key_seen' });
    expect(await w.tasksOf(pr, 'fix')).toHaveLength(1);
  }, 90_000);

  test('approve and override: refused when stale, by an agent, without permission; once allowed it approves the head, publishes success and lands once', async () => {
    w = await world();
    const pr = await exhausted(w);
    const h2 = await pushFixToA(w, pr);
    const v = (await w.delivery(pr)).version;
    const approve = (o: Partial<Parameters<typeof seam.approveOverrideThroughKernel>[0]> = {}) => seam.approveOverrideThroughKernel({
      workspaceId: w.workspaceId, prNumber: pr.prNumber, actor: 'human:u1', decision: { headSha: h2, version: v },
      reason: 'accepted as is', hasMergePermission: true, overridePermitted: true, ...o,
    });

    expect((await approve({ decision: { headSha: pr.head, version: v } }))?.result).toMatchObject({ result: 'rejected', reason: 'decision_head_stale' });
    expect((await approve({ actor: 'agent:t9' }))?.result).toMatchObject({ result: 'rejected', reason: 'human_required' });
    expect((await approve({ hasMergePermission: false }))?.result).toMatchObject({ result: 'rejected', reason: 'no_merge_permission' });
    expect((await approve({ overridePermitted: false }))?.result).toMatchObject({ result: 'rejected', reason: 'override_not_permitted' });
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_exhausted', version: v });

    const first = await approve();
    expect(first?.result.result).toBe('applied');
    expect(await w.delivery(pr)).toMatchObject({ approvedHeads: [h2], approvalBasis: 'human' });
    expect((await approve())?.result).toMatchObject({ result: 'duplicate', reason: 'idempotency_key_seen' });
    const audits = await q<{ bypass: Record<string, unknown> }>(sql`
      SELECT bypass FROM workflow_transitions WHERE delivery_id = ${pr.deliveryId}::uuid AND command = 'HumanResolve'`);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.bypass).toMatchObject({ choice: 'approve', actor: 'human:u1', reason: 'accepted as is', headSha: h2 });
    expect((audits[0]!.bypass.overriddenFindings as string[]).length).toBe(2);
    // The findings stay listed: an override is not a fix.
    expect(await statesOf(w, pr)).toEqual({ 'src/a.ts': 'addressed', 'src/b.ts': 'open' });

    // The required check reflects it, naming the person's override: pending while CI has not read
    // green at this head (aa415afd), success once it has.
    const { githubReader } = await import('../../src/lib/workflow/github-facts');
    const shownNow = () => githubReader(w.installationId).statusOf!(w.repo, h2, 'Buildd / Review approval');
    const waiting = await shownNow();
    expect(waiting).toMatchObject({ state: 'pending' });
    expect(waiting?.description ?? '').toContain('approved by a person over 2 open findings');

    w.gh.greenCi(w.repo, h2, ['build', 'test']);
    await w.deliver();
    const shown = await shownNow();
    expect(shown).toMatchObject({ state: 'success' });
    expect(shown?.description ?? '').toContain('approved by a person over 2 open findings');
    await w.land(pr, h2);
    await w.deliver();
    expect((await approve())?.result.result).toBe('duplicate');
    expect(w.mergeCalls(pr)).toHaveLength(1);
  }, 90_000);
});

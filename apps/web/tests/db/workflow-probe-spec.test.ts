/**
 * Adversarial probe, lens 1 (spec vs code): transitions the reducer allows, or
 * leaves out, that docs/specs/workflow-state-kernel.md does not. Each test is a
 * sequence on the real kernel + real Postgres + the stateful fake GitHub and
 * asserts what the SPEC says should happen. A failing test is a finding.
 *
 * Every finding test asserts the CORRECT behaviour and is marked `test.failing`
 * because it fails on dev today (probe task e769323f). Bun reports a
 * `test.failing` that starts passing as a failure, so the PR that fixes a
 * finding must turn its test(s) back into plain `test`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { seam, world, type World } from './workflow-scenarios-world';
import { q } from './harness';
import { applyCommand } from '../../src/lib/workflow/kernel';

let w: World;
import { appendFileSync } from 'node:fs';
const dbg = (...a: unknown[]) => { if (process.env.PROBE_DEBUG) appendFileSync(process.env.PROBE_DEBUG, a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n'); };
afterEach(() => w?.dispose());

const ciFixTask = async (w: World, pr: Awaited<ReturnType<World['openPr']>>) => {
  const [t] = await w.tasksOf(pr, 'ci_fix');
  if (!t) throw new Error('no ci_fix task');
  return { id: t.id, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'ci_fix', context: t.context };
};

describe('probe: a verdict that lands while a no-op repair holds the delivery', () => {
  test.failing('reviewer requests changes at H while CI flaked red on H; CI re-runs green before the fix claims → the request_changes at the CURRENT head is not lost (no second round at H, §8.2 / #3754 step 2)', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/flaky', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    const rv1 = await w.reviewer(pr);
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 1, currentHeadSha: pr.head });

    // CI flakes red on H while the reviewer is still running: T10 → REPAIRING(ci).
    w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'failure' });
    await w.deliver();
    expect(await w.delivery(pr)).toMatchObject({ state: 'REPAIRING', stateReason: 'ci' });

    // The reviewer finishes: request changes, bound to H, which is STILL the PR's head.
    const v1 = await w.verdict(pr, rv1, 'request_changes', pr.head);
    expect(v1).toMatchObject({ handled: true });

    // The flake re-runs green before the CI fix is claimed: the repair is not needed.
    w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'success' });
    await w.deliver();
    const claim = await seam.claimFix(await ciFixTask(w, pr));
    expect(claim.action).toBe('cancel');

    const v = await w.view(pr);
    // Head never moved. Spec §8.2: a request-changes verdict at H blocks until a round at a
    // DIFFERENT head decides; a second round at the same head is refused (head_already_reviewed).
    expect(v.delivery!.currentHeadSha).toBe(pr.head);
    const roundsAtH = v.rounds.filter((r) => r.headSha === pr.head);
    expect(roundsAtH.length).toBe(1);
    expect(v.delivery!.state).toBe('CHANGES_REQUESTED');
  });

  test.failing('…and the consequence: a second reviewer at the same unchanged head approves and the PR lands over the first reviewer\'s request_changes', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/flaky-land', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    const rv1 = await w.reviewer(pr);
    w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'failure' });
    await w.deliver();
    await w.verdict(pr, rv1, 'request_changes', pr.head);
    w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'success' });
    await w.deliver();
    await seam.claimFix(await ciFixTask(w, pr));

    // If a fresh round at H exists, its reviewer can approve the very head the first one rejected.
    const d = await w.delivery(pr);
    if (d.state === 'AWAITING_REVIEW' && d.currentRound === 2) {
      const rv2 = await w.reviewer(pr);
      const v2 = await w.verdict(pr, rv2, 'approve', pr.head);
      const landed = await w.land(pr, pr.head);
      // Record what happened for the report, then assert the spec.
      dbg('[probe] second verdict', JSON.stringify(v2 && 'toState' in v2 ? v2.toState : v2), 'landing', JSON.stringify(landed).slice(0, 200));
    }
    const rounds = (await w.view(pr)).rounds.filter((r) => r.headSha === pr.head);
    // Spec: a request_changes at H can only be cleared by a round at a different head.
    expect(rounds.some((r) => r.effectiveVerdict === 'approve')).toBe(false);
    expect(w.gh.pr(w.repo, pr.prNumber).merged).toBe(false);
  });

  test.failing('flaky CI repeatedly → each flake burns a review round number at the same head; the round budget (max_rounds) is spent by flakes, not by fix cycles (§8.2: max_rounds counts rounds of review)', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/flaky-budget', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    for (let i = 0; i < 2; i++) {
      const rv = await w.reviewer(pr);
      w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'failure' });
      await w.deliver();
      await w.verdict(pr, rv, 'approve', pr.head);
      w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'success' });
      await w.deliver();
      await q(sql`UPDATE workflow_effects SET not_before = now() WHERE delivery_id = ${pr.deliveryId}::uuid AND status = 'pending'`);
      await seam.drainDelivery(pr.deliveryId);
      const vv = await w.view(pr);
      const att = vv.attempts.find((a) => a.id === vv.delivery!.boundAttemptId);
      const tasks = await w.tasksOf(pr, 'ci_fix');
      const effs = await w.effects(pr);
      dbg('[probe] flaky pre-claim', i, 'bound', att, 'tasks', tasks.map((x) => [x.id, x.status, x.context.workflowAttemptId]), 'effects', effs.filter((e) => e.kind === 'dispatch_ci_fix'));
      const t = tasks.find((x) => x.context.workflowAttemptId === att?.id);
      // Dispatch-time revalidation may already have resumed (RepairNotNeeded, ci_green).
      const cl = !t ? { action: 'resumed_at_dispatch' as const } : await seam.claimFix({ id: t.id, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'ci_fix', context: t.context });
      if (t && cl.action === 'cancel') await seam.cancelSkippedTask(t.id, (cl as { reason: string }).reason);
      const dd = await w.delivery(pr);
      dbg('[probe] flaky iter', i, 'claim', cl, 'state', dd.state, dd.stateReason, 'round', dd.currentRound, 'cmds', await w.commands(pr));
    }
    const d = await w.delivery(pr);
    const v = await w.view(pr);
    dbg('[probe] flaky final', d.state, d.currentRound, v.rounds.map((r) => [r.round, r.headSha.slice(0, 7), r.status, r.effectiveVerdict]));
    // Two approvals of the one unchanged head H were delivered; the spec has the delivery APPROVED at H
    // after the first, with one round. Each flake instead discards the verdict and spends a round number.
    expect({ state: d.state, round: d.currentRound }).toEqual({ state: 'APPROVED', round: 1 });
  });
});

describe('probe: BLOCKED_ON_TRUNK resumes into a state its head does not satisfy', () => {
  test.failing('approved at H1, blocked on a red trunk, the author pushes new code H2 while blocked, trunk recovers → spec T26/§6.4: resume re-entered AT THE CURRENT HEAD (APPROVED needs coverage of H2, else round r+1); not an uncovered APPROVED nobody can land', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/blocked-push', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    expect(await w.delivery(pr)).toMatchObject({ state: 'APPROVED', currentHeadSha: pr.head });

    // dev goes red on lint and H1 fails the same check → BLOCKED_ON_TRUNK, resume APPROVED.
    const devHead = w.gh.branchHead(w.repo, 'dev')!;
    w.gh.setCheck(w.repo, devHead, 'lint', { conclusion: 'failure' });
    w.gh.setCheck(w.repo, pr.head, 'lint', { conclusion: 'failure' });
    await w.deliver();
    expect(await w.delivery(pr)).toMatchObject({ state: 'BLOCKED_ON_TRUNK', resumeState: 'APPROVED' });

    // The trunk fix lands on dev and goes green.
    const fixed = w.gh.advanceBase(w.repo, 'dev', { 'src/fix.ts': 'export const fixed = true;\n' });
    w.gh.greenCi(w.repo, fixed, ['lint', 'build', 'test']);
    await w.deliver();
    // While still blocked (the sweep has not run), the author merges dev in and pushes new code.
    w.gh.updateBranch(w.repo, pr.prNumber, { by: 'dev' });
    await w.deliver();
    const h2 = w.gh.push(w.repo, pr.branch, { 'src/b.ts': 'export const b = 99; // unreviewed\n' }, { message: 'new code', pusher: 'dev' });
    await w.deliver();
    w.gh.greenCi(w.repo, h2, ['lint', 'build', 'test']);
    expect(await w.delivery(pr)).toMatchObject({ state: 'BLOCKED_ON_TRUNK', currentHeadSha: h2 });

    await seam.reconcileTrunkIncidents();
    await w.deliver();

    const v = await w.view(pr);
    const d = v.delivery!;
    expect(d.currentHeadSha).toBe(h2);
    // Never an APPROVED whose current head no verdict covers.
    if (d.state === 'APPROVED') expect(d.approvedHeads).toContain(h2);
    // The spec's resume: H2 is unreviewed new code → a round at H2.
    expect(d.state).toBe('AWAITING_REVIEW');
    expect(v.rounds.some((r) => r.headSha === h2 && (r.status === 'queued' || r.status === 'reviewing'))).toBe(true);
  });

  test.failing('…and the consequence: the delivery is stranded: every landing door is refused (head_not_approved) and the §11 floor owes nothing', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/blocked-stranded', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    const devHead = w.gh.branchHead(w.repo, 'dev')!;
    w.gh.setCheck(w.repo, devHead, 'lint', { conclusion: 'failure' });
    w.gh.setCheck(w.repo, pr.head, 'lint', { conclusion: 'failure' });
    await w.deliver();
    const fixed = w.gh.advanceBase(w.repo, 'dev', { 'src/fix.ts': 'export const fixed = true;\n' });
    w.gh.greenCi(w.repo, fixed, ['lint', 'build', 'test']);
    await w.deliver();
    w.gh.updateBranch(w.repo, pr.prNumber, { by: 'dev' });
    await w.deliver();
    const h2 = w.gh.push(w.repo, pr.branch, { 'src/b.ts': 'export const b = 99;\n' }, { message: 'new code', pusher: 'dev' });
    await w.deliver();
    w.gh.greenCi(w.repo, h2, ['lint', 'build', 'test']);
    await seam.reconcileTrunkIncidents();
    await w.deliver();

    const landed = await w.land(pr, h2);
    await w.floor(pr);
    await w.deliver();
    const d = await w.delivery(pr);
    const effectsOwed = (await w.effects(pr)).filter((e) => e.status === 'pending' || e.status === 'delivering');
    dbg('[probe] stranded state', d.state, 'approvedHeads', d.approvedHeads, 'land', JSON.stringify(landed).slice(0, 300), 'owed', effectsOwed.map((e) => e.kind));
    // §4: every non-terminal state has exactly one owner of the next move. APPROVED's owner is
    // landing; if landing refuses and nothing else is owed, nobody owns it.
    const reviewerOwed = (await w.view(pr)).rounds.some((r) => r.headSha === h2);
    expect(reviewerOwed || w.gh.pr(w.repo, pr.prNumber).merged).toBe(true);
  });
});

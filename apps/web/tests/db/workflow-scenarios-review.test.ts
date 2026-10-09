/**
 * Named incident scenarios, review half: the fix loop that never pushed
 * (#3754), a verdict that arrives after its head was replaced, and stacked
 * PRs. The real kernel on real Postgres against the stateful fake GitHub; see
 * workflow-scenarios-world.ts. The test name is the sequence and the outcome.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';
import { seam, world, type World } from './workflow-scenarios-world';

let w: World;
afterEach(() => w?.dispose());

/** The fix task the request-changes dispatched, as the claim route hands it to the seam. */
async function fixTaskOf(w: World, pr: Awaited<ReturnType<World['openPr']>>) {
  const [t] = await w.tasksOf(pr, 'fix');
  if (!t) throw new Error('no fix task filed');
  return { id: t.id, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'fix', context: t.context };
}

describe('the #3754 fix loop', () => {
  test('changes requested at H1; the fix commits locally but never pushes → completion refused, the ended attempt is AWAITING_PUSH, a re-review of H1 is rejected; the late push goes back to review at the pushed head', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/fix-loop', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    const r1 = await w.reviewer(pr);
    expect(await w.verdict(pr, r1, 'request_changes', pr.head)).toMatchObject({ handled: true, toState: 'CHANGES_REQUESTED' });
    expect(w.gh.pr(w.repo, pr.prNumber).reviews).toEqual([expect.objectContaining({ state: 'CHANGES_REQUESTED', commitId: pr.head })]);

    const fix = await fixTaskOf(w, pr);
    expect(await seam.claimFix(fix)).toEqual({ action: 'proceed' });
    expect((await w.delivery(pr)).state).toBe('FIXING');

    // The fix worker commits L on a branch GitHub has, but never moves the PR head to it.
    w.gh.createBranch(w.repo, 'local/fix-loop', pr.branch);
    const local = w.gh.push(w.repo, 'local/fix-loop', { 'src/a.ts': 'export const a = 3;\n' });
    await w.deliver();

    const refusal = await seam.fixCompletionGate({ task: fix, localHeadSha: local });
    expect(refusal).toMatchObject({ code: 'delivery_not_advanced', boundHeadSha: pr.head, liveHeadSha: pr.head, localHeadSha: local });

    // The worker goes away anyway: never AWAITING_REVIEW at the old head.
    const [fw] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, commit_count)
      VALUES (${w.workspaceId}::uuid, ${fix.id}::uuid, 'fix', 'test', ${pr.branch}, 'completed', ${local}, 1) RETURNING id`);
    await seam.attemptEnded({ task: fix, workerId: fw.id, status: 'completed', localHeadSha: local, commitCount: 1, source: 'runner' });
    let v = await w.view(pr);
    expect(v.delivery).toMatchObject({ state: 'AWAITING_PUSH', currentHeadSha: pr.head });
    expect(v.attempts.find((a) => a.family === 'review_fix')).toMatchObject({ status: 'ended', outcome: 'unproven' });
    expect(v.rounds).toHaveLength(1);
    expect((await w.effects(pr)).filter((e) => e.kind === 'push_recovery')).toHaveLength(1);

    // "Re-review after fix 1" against the unchanged H1 is not reachable.
    const again = await seam.requestReview({ workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId, forced: false, actor: 'kernel' });
    expect(again).toMatchObject({ handled: true, result: { result: 'rejected', reason: 'state_not_allowed' } });
    expect(await w.tasksOf(pr, 'review')).toHaveLength(1);

    // The push finally lands (the PR head moves to L): round 2 is a delta at L, the attempt delivered.
    await w.gh.request('PATCH', `/repos/${w.repo}/git/refs/heads/${pr.branch}`, { sha: local, force: false });
    await w.deliver();
    v = await w.view(pr);
    expect(v.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: local });
    expect(v.rounds.map((r) => [r.round, r.headSha, r.kind])).toEqual([[1, pr.head, 'full'], [2, local, 'delta']]);
    expect(v.attempts.find((a) => a.family === 'review_fix')).toMatchObject({ outcome: 'delivered' });
  });
});

describe('a review verdict for a replaced head arrives late', () => {
  test('round 1 reviews H1, the author pushes H2, then round 1 approves H1 → kept on its round for audit, never applied: no approval, no GitHub review, H1 cannot land', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/late-verdict', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    const r1 = await w.reviewer(pr);
    const h2 = w.gh.push(w.repo, pr.branch, { 'src/a.ts': 'export const a = 3;\n' });
    await w.deliver();
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: h2, currentRound: 2 });

    const late = await w.verdict(pr, r1, 'approve', pr.head);
    expect(late).toMatchObject({ handled: true, toState: null });
    const v = await w.view(pr);
    expect(v.delivery).toMatchObject({ state: 'AWAITING_REVIEW', approvedHeads: [] });
    expect(v.rounds.find((r) => r.id === r1.context.workflowRoundId)).toMatchObject({ status: 'superseded', verdict: 'approve' });
    expect(w.gh.pr(w.repo, pr.prNumber).reviews).toEqual([]);
    expect((await w.effects(pr)).some((e) => e.kind === 'post_review')).toBe(false);

    // Neither head lands on it.
    w.gh.greenCi(w.repo, h2, ['build']);
    expect(await w.land(pr, pr.head)).toMatchObject({ merged: false, outcome: 'stale', reason: 'head_moved' });
    expect(await w.land(pr, h2)).toMatchObject({ merged: false, outcome: 'rejected' });
    expect(w.mergeCalls(pr)).toEqual([]);

    // The round that owns H2 decides.
    const r2 = await w.reviewer(pr);
    expect(r2.context.headSha).toBe(h2);
    expect(await w.verdict(pr, r2, 'approve', h2)).toMatchObject({ toState: 'APPROVED' });
    expect(w.gh.pr(w.repo, pr.prNumber).reviews).toEqual([expect.objectContaining({ state: 'APPROVED', commitId: h2 })]);
  });

  test('a request-changes for a replaced head arrives late → no fix is filed and the current round is untouched', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/late-rc', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    const r1 = await w.reviewer(pr);
    const h2 = w.gh.push(w.repo, pr.branch, { 'src/a.ts': 'export const a = 3;\n' });
    await w.deliver();
    expect(await w.verdict(pr, r1, 'request_changes', pr.head)).toMatchObject({ handled: true, toState: null });
    expect(await w.tasksOf(pr, 'fix')).toEqual([]);
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: h2 });
    expect(w.gh.pr(w.repo, pr.prNumber).reviews).toEqual([]);
  });
});

describe('stacked PRs', () => {
  test('B is stacked on A (B\'s base is A\'s branch, B\'s task depends on A\'s); both approved; A lands → A MERGED and its task completed, B neither merged nor completed', async () => {
    w = await world();
    const a = await w.openPr({ branch: 'feat/stack-a', files: { 'src/a.ts': 'export const a = 2;\n' } });
    const b = await w.openPr({ branch: 'feat/stack-b', base: 'feat/stack-a', files: { 'src/b.ts': 'export const b = 2;\n' }, dependsOn: [a.ownerTaskId] });
    expect(await w.delivery(b)).toMatchObject({ baseRef: 'feat/stack-a' });
    await w.approve(a);
    await w.approve(b);

    expect(await w.land(a, a.head)).toMatchObject({ merged: true });
    await w.deliver();
    expect(await w.delivery(a)).toMatchObject({ state: 'MERGED' });
    expect(await w.taskStatus(a.ownerTaskId)).toBe('completed');

    // B: still open on GitHub, nothing merged it, its delivery and task did not move.
    expect(w.gh.pr(w.repo, b.prNumber)).toMatchObject({ state: 'open', merged: false });
    expect(w.mergeCalls(b)).toEqual([]);
    expect(await w.delivery(b)).toMatchObject({ state: 'APPROVED', currentHeadSha: b.head });
    expect(await w.taskStatus(b.ownerTaskId)).toBe('in_progress');
    expect((await w.commands(b)).includes('PrMerged')).toBe(false);
  });

  test('then B is retargeted onto dev and lands on its own → B MERGED into dev with both changes, and only then is B\'s task completed', async () => {
    w = await world();
    const a = await w.openPr({ branch: 'feat/stack-a', files: { 'src/a.ts': 'export const a = 2;\n' } });
    const b = await w.openPr({ branch: 'feat/stack-b', base: 'feat/stack-a', files: { 'src/b.ts': 'export const b = 2;\n' }, dependsOn: [a.ownerTaskId] });
    await w.approve(a);
    await w.approve(b);
    expect(await w.land(a, a.head)).toMatchObject({ merged: true });
    await w.deliver();

    // GitHub retargets the top PR when its base merges (here: by hand, as the fake does not).
    await w.gh.request('PATCH', `/repos/${w.repo}/pulls/${b.prNumber}`, { base: 'dev' });
    expect(await w.taskStatus(b.ownerTaskId)).toBe('in_progress');
    const landed = await w.land(b, b.head);
    expect(landed).toMatchObject({ merged: true });
    expect(await w.delivery(b)).toMatchObject({ state: 'MERGED' });
    expect(w.gh.files(w.repo, 'dev')).toMatchObject({ 'src/a.ts': 'export const a = 2;\n', 'src/b.ts': 'export const b = 2;\n' });
    expect(await w.taskStatus(b.ownerTaskId)).toBe('completed');
  });
});

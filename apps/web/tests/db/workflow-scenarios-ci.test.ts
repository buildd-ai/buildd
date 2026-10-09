/**
 * Named incident scenarios, CI half (spec §6.3 T10, §6.5 row 1): what a CI
 * failure does when it lands on a delivery that cannot act on it yet. The real
 * kernel on real Postgres against the stateful fake GitHub; see
 * workflow-scenarios-world.ts. The test name is the sequence and the outcome.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { world, type World } from './workflow-scenarios-world';

let w: World;
afterEach(() => w?.dispose());

describe('CI goes red while the owner is still working (task e9f1674b)', () => {
  test('the owner pushes H, build fails on H and the failure hint arrives while WORKING (refused there), the owner ends with no further push → REPAIRING(ci) at H with one CI attempt dispatched, no review round, no sweep needed', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/red-mid-work', files: { 'src/a.ts': 'export const a = 2;\n' } });
    w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'failure' });
    await w.deliver();
    // T10 cannot move WORKING: the owner still owns the next move, so nothing is interrupted.
    expect(await w.delivery(pr)).toMatchObject({ state: 'WORKING', currentHeadSha: pr.head });
    expect((await w.view(pr)).attempts.filter((a) => a.family === 'ci')).toEqual([]);

    await w.handOn(pr);

    const v = await w.view(pr);
    expect(v.delivery).toMatchObject({ state: 'REPAIRING', stateReason: 'ci', currentHeadSha: pr.head, ci: 'red', ciHeadSha: pr.head });
    const ci = v.attempts.filter((a) => a.family === 'ci');
    expect(ci).toHaveLength(1);
    expect(ci[0]).toMatchObject({ attemptNo: 1, boundHeadSha: pr.head, triggerReason: 'ci:build' });
    expect(v.delivery?.boundAttemptId).toBe(ci[0].id);
    // No reviewer is spent on a head that is red: the round starts when the repair resumes.
    expect(v.rounds).toEqual([]);
    expect(await w.tasksOf(pr, 'review')).toEqual([]);
    expect((await w.effects(pr)).filter((e) => e.kind === 'dispatch_ci_fix')).toHaveLength(1);
    expect(await w.tasksOf(pr, 'ci_fix')).toHaveLength(1);
    expect((await w.commands(pr)).at(-1)).toBe('AttemptEnded');
  });

  test('build fails on H while WORKING, is re-run green before the owner ends → a normal hand-off: AWAITING_REVIEW, round 1 at H, no CI attempt', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/red-then-green', files: { 'src/a.ts': 'export const a = 2;\n' } });
    w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'failure' });
    await w.deliver();
    w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'success' });
    await w.deliver();

    await w.handOn(pr);

    const v = await w.view(pr);
    expect(v.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 1, currentHeadSha: pr.head });
    expect(v.attempts.filter((a) => a.family === 'ci')).toEqual([]);
    expect((await w.reviewer(pr)).context.headSha).toBe(pr.head);
  });

  test('build fails on H while WORKING and the check read fails when the owner ends → the hand-off is unchanged (AWAITING_REVIEW at H); the red is left to the next hint or sweep', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/red-unreadable', files: { 'src/a.ts': 'export const a = 2;\n' } });
    w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'failure' });
    await w.deliver();
    w.gh.failNext(/check-runs/, 403);

    await w.handOn(pr);

    const v = await w.view(pr);
    expect(v.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 1, currentHeadSha: pr.head });
    expect(v.attempts.filter((a) => a.family === 'ci')).toEqual([]);
  });
  test('dev itself fails build, H fails build too while WORKING, the owner ends → the trunk explains it (§6.10): BLOCKED_ON_TRUNK, no per-PR CI attempt', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/red-trunk', files: { 'src/a.ts': 'export const a = 2;\n' } });
    w.gh.setCheck(w.repo, w.gh.branchHead(w.repo, 'dev')!, 'build', { conclusion: 'failure' });
    w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'failure' });
    await w.deliver();

    await w.handOn(pr);

    const v = await w.view(pr);
    expect(v.delivery).toMatchObject({ state: 'BLOCKED_ON_TRUNK', resumeState: 'AWAITING_REVIEW', currentHeadSha: pr.head });
    expect(v.attempts.filter((a) => a.family === 'ci')).toEqual([]);
    expect(await w.tasksOf(pr, 'ci_fix')).toEqual([]);
  });
});

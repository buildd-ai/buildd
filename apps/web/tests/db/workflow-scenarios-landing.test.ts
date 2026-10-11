/**
 * Named incident scenarios, landing half: the head or base moving under a
 * merge (GitHub's 409 and 405), mergeability GitHub has not computed yet, and
 * a red base branch. The real kernel on real Postgres against the stateful
 * fake GitHub; see workflow-scenarios-world.ts. The test name is the sequence
 * and the outcome.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';
import { seam, world, type World } from './workflow-scenarios-world';

const { landPr } = await import('../../src/lib/pr-landing');
const { DEFAULT_MAX_BEHIND_REFRESHES } = await import('../../src/lib/workflow/reducer');

let w: World;
afterEach(() => w?.dispose());

const updateBranchCalls = (w: World, prNumber: number) =>
  w.gh.calls.filter((c) => c.method === 'PUT' && c.path === `/repos/${w.repo}/pulls/${prNumber}/update-branch`);

describe('the head or the base moves between the read and the merge', () => {
  test('approved at H1; someone pushes H2 between the door\'s read and the pinned merge (409) → nothing merged, one merge call, landable again only after H2 is reviewed', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/race-409', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);

    w.setFaults({ headMovesBeforeWrite: 1 });
    const landed = await w.land(pr, pr.head);
    w.setFaults({ headMovesBeforeWrite: 0 });
    expect(landed).toMatchObject({ merged: false });
    expect(w.mergeCalls(pr).map((c) => c.status)).toEqual([409]);
    expect(w.gh.pr(w.repo, pr.prNumber)).toMatchObject({ state: 'open', merged: false });
    // The merge is not in flight and nothing is owed a person.
    expect((await w.delivery(pr)).state).toBe('APPROVED');
    expect((await w.commands(pr)).slice(-2)).toEqual(['LandingRequested', 'MergeCallResult']);

    // The interloper's synchronize: the head moved by a real change, so H1's approval no longer covers it.
    await w.deliver();
    const h2 = w.gh.pr(w.repo, pr.prNumber).headSha;
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: h2 });
    // A door still holding H1 is stale, and makes no second merge call.
    expect(await w.land(pr, pr.head)).toMatchObject({ merged: false, outcome: 'stale', reason: 'head_moved' });
    expect(w.mergeCalls(pr)).toHaveLength(1);

    // H2 reviewed and landed: exactly one merge succeeded, ever.
    await w.approve(pr, h2);
    expect(await w.land(pr, h2)).toMatchObject({ merged: true });
    expect(w.mergeCalls(pr).map((c) => c.status)).toEqual([409, 200]);
    expect((await w.commands(pr)).filter((c) => c === 'PrMerged')).toHaveLength(1);
  });

  test('approved at H1 on a base that requires up-to-date branches; the base advances before the merge (405 behind) → one pinned update-branch, the approval carries, the refreshed head lands', async () => {
    w = await world();
    w.gh.protect(w.repo, 'dev', { strict: true });
    const pr = await w.openPr({ branch: 'feat/race-405', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    w.gh.advanceBase(w.repo, 'dev', { 'src/b.ts': 'export const b = 2;\n' });
    await w.deliver();

    const first = await w.land(pr, pr.head);
    expect(first).toMatchObject({ merged: false });
    expect(w.mergeCalls(pr).map((c) => c.status)).toEqual([405]);
    expect(updateBranchCalls(w, pr.prNumber).map((c) => c.status)).toEqual([202]);
    await w.deliver();
    const refreshed = w.gh.pr(w.repo, pr.prNumber).headSha;
    expect(refreshed).not.toBe(pr.head);
    const d = await w.delivery(pr);
    expect(d).toMatchObject({ state: 'APPROVED', currentHeadSha: refreshed });
    expect(d.approvedHeads).toEqual(expect.arrayContaining([pr.head, refreshed]));
    expect(await w.tasksOf(pr, 'review')).toHaveLength(1);

    w.gh.greenCi(w.repo, refreshed, ['build']);
    expect(await w.land(pr, refreshed)).toMatchObject({ merged: true });
    expect(w.mergeCalls(pr).map((c) => c.status)).toEqual([405, 200]);
    expect(updateBranchCalls(w, pr.prNumber)).toHaveLength(1);
    expect(w.gh.files(w.repo, 'dev')).toMatchObject({ 'src/a.ts': 'export const a = 2;\n', 'src/b.ts': 'export const b = 2;\n' });
  });

  test('the base keeps advancing after every refresh → the refreshes are bounded, then a person is asked; never a merge of a stale head', async () => {
    w = await world();
    w.gh.protect(w.repo, 'dev', { strict: true });
    const pr = await w.openPr({ branch: 'feat/treadmill', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    for (let i = 0; i < DEFAULT_MAX_BEHIND_REFRESHES + 2; i++) {
      w.gh.advanceBase(w.repo, 'dev', { [`src/other-${i}.ts`]: `export const o = ${i};\n` });
      await w.deliver();
      const d = await w.delivery(pr);
      if (d.state !== 'APPROVED') break;
      await w.land(pr, d.currentHeadSha!);
      await w.deliver();
    }
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'landing_needs_human' });
    expect(updateBranchCalls(w, pr.prNumber)).toHaveLength(DEFAULT_MAX_BEHIND_REFRESHES);
    expect(w.mergeCalls(pr).every((c) => c.status === 405)).toBe(true);
    expect(w.gh.pr(w.repo, pr.prNumber).merged).toBe(false);
  });
});

describe('mergeable stays unknown for a while', () => {
  test('GitHub answers mergeable: null for the first reads of every head; the landing door keeps asking → it never fails or pages a person, and lands once with one merge call', async () => {
    w = await world();
    w.setFaults({ mergeableUnknownReads: 6 });
    const pr = await w.openPr({ branch: 'feat/unknown', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    const outcomes: string[] = [];
    for (let tick = 0; tick < 8 && !outcomes.includes('merged'); tick++) {
      const o = await landPr({
        workspaceId: w.workspaceId, installationId: w.installationId, repoFullName: w.repo, prNumber: pr.prNumber, eventHeadSha: null,
        door: 'sweep', actor: { kind: 'system' }, mode: 'enforce', policy: { tier: 'auto-threshold' }, owner: { taskId: pr.ownerTaskId, workerId: pr.workerId },
      });
      outcomes.push(o.kind);
      expect(['merged', 'waiting_ci', 'updating_branch']).toContain(o.kind);
      expect((await w.delivery(pr)).state).not.toBe('ESCALATED');
    }
    expect(outcomes.at(-1)).toBe('merged');
    expect(w.mergeCalls(pr).map((c) => c.status)).toEqual([200]);
    expect(await w.delivery(pr)).toMatchObject({ state: 'MERGED' });
    expect(w.gh.unsupported).toEqual([]);
  });

  test('a door holding a stale "dirty" snapshot asks while GitHub still says unknown → a mechanical refresh only (no agent task), and the approval survives it', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/unknown-dirty', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    w.setFaults({ mergeableUnknownReads: 4 });
    w.gh.advanceBase(w.repo, 'dev', { 'src/b.ts': 'export const b = 2;\n' });
    await w.deliver();

    const seen = await seam.observeConflict({
      workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId,
      hint: 'dirty', isDependencyBot: false, maxAgentAttempts: 2, source: 'sweep:dead-zone',
    });
    expect(seen).toMatchObject({ handled: true, mergeable: 'unknown', attempt: { family: 'conflict', mode: 'mechanical', outcome: 'delivered', taskId: null } });
    await w.deliver();
    expect(await w.tasksOf(pr, 'conflict_fix')).toEqual([]);
    const head = w.gh.pr(w.repo, pr.prNumber).headSha;
    expect(await w.delivery(pr)).toMatchObject({ state: 'APPROVED', currentHeadSha: head });
    expect(updateBranchCalls(w, pr.prNumber)).toHaveLength(1);
  });
});

describe('the base branch goes red', () => {
  test('dev fails lint and two open PRs fail with it, then dev also fails test → both PRs BLOCKED_ON_TRUNK, no per-PR CI fix, exactly ONE trunk-fix task for the base; dev recovers → both resume review, refreshed onto the fix', async () => {
    w = await world();
    const a = await w.openPr({ branch: 'feat/red-a', files: { 'src/a.ts': 'export const a = 2;\n' } });
    const b = await w.openPr({ branch: 'feat/red-b', files: { 'src/c.ts': 'export const c = 2;\n' } });
    await w.handOn(a);
    await w.handOn(b);
    const devHead = w.gh.branchHead(w.repo, 'dev')!;

    // dev goes red on lint; PR a's CI reports the same failure.
    w.gh.setCheck(w.repo, devHead, 'lint', { conclusion: 'failure' });
    w.gh.setCheck(w.repo, a.head, 'lint', { conclusion: 'failure' });
    await w.deliver();
    // dev then fails test as well (its runs were read before every check finished); PR b fails only that.
    w.gh.setCheck(w.repo, devHead, 'test', { conclusion: 'failure' });
    w.gh.setCheck(w.repo, b.head, 'test', { conclusion: 'failure' });
    await w.deliver();
    // CI reports again (a re-run, the red-PR sweep): nothing more is filed.
    w.gh.setCheck(w.repo, a.head, 'lint', { conclusion: 'failure' });
    await w.deliver();

    for (const p of [a, b]) {
      expect(await w.delivery(p)).toMatchObject({ state: 'BLOCKED_ON_TRUNK', resumeState: 'AWAITING_REVIEW' });
      expect(await w.tasksOf(p, 'ci_fix')).toEqual([]);
      expect((await w.view(p)).attempts.filter((x) => x.family === 'ci' && x.status !== 'skipped')).toEqual([]);
    }
    const incidents = await q<{ status: string; signature: string; trunk_fix_task_id: string | null }>(
      sql`SELECT status, signature, trunk_fix_task_id FROM trunk_incidents WHERE workspace_id = ${w.workspaceId}::uuid ORDER BY first_seen_at, id`);
    expect(incidents.map((i) => i.signature)).toEqual(['ci:lint', 'ci:lint|test']);
    const trunkFixes = await q<{ id: string; title: string }>(
      sql`SELECT id, title FROM tasks WHERE workspace_id = ${w.workspaceId}::uuid AND context->>'trunkIncidentId' IS NOT NULL`);
    expect(trunkFixes).toHaveLength(1);
    expect(incidents.every((i) => i.trunk_fix_task_id === trunkFixes[0].id)).toBe(true);

    // The trunk fix lands on dev and dev goes green: the recovery sweep resolves both incidents.
    const fixed = w.gh.advanceBase(w.repo, 'dev', { 'src/fix.ts': 'export const fixed = true;\n' });
    w.gh.greenCi(w.repo, fixed, ['lint', 'test']);
    await w.deliver();
    expect(await seam.reconcileTrunkIncidents()).toMatchObject({ errors: 0 });
    await w.deliver();
    expect((await q<{ status: string }>(sql`SELECT status FROM trunk_incidents WHERE workspace_id = ${w.workspaceId}::uuid`)).map((i) => i.status)).toEqual(['resolved', 'resolved']);
    for (const p of [a, b]) {
      const d = await w.delivery(p);
      expect(d).toMatchObject({ state: 'AWAITING_REVIEW', trunkIncidentId: null });
      // Each head predated the fix: it was refreshed onto it (one pinned update-branch), with its CI budget untouched.
      expect(d.currentHeadSha).toBe(w.gh.pr(w.repo, p.prNumber).headSha);
      expect(w.gh.isAncestor(w.repo, fixed, d.currentHeadSha!)).toBe(true);
      expect(updateBranchCalls(w, p.prNumber)).toHaveLength(1);
      expect((await w.view(p)).attempts.filter((x) => x.family === 'ci' && x.status !== 'skipped')).toEqual([]);
    }
    // Still one trunk fix, ever, for that red episode.
    expect(await q(sql`SELECT id FROM tasks WHERE workspace_id = ${w.workspaceId}::uuid AND context->>'trunkIncidentId' IS NOT NULL`)).toHaveLength(1);
  });

  test('a PR fails a check dev passes while dev is red on another → not the trunk\'s fault: the PR gets its own CI fix, the trunk incident does not take it', async () => {
    w = await world();
    const a = await w.openPr({ branch: 'feat/own-red', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(a);
    w.gh.setCheck(w.repo, w.gh.branchHead(w.repo, 'dev')!, 'lint', { conclusion: 'failure' });
    w.gh.setCheck(w.repo, a.head, 'typecheck', { conclusion: 'failure' });
    await w.deliver();
    expect(await w.delivery(a)).toMatchObject({ state: 'REPAIRING', stateReason: 'ci', trunkIncidentId: null });
    expect(await w.tasksOf(a, 'ci_fix')).toHaveLength(1);
    expect(await q(sql`SELECT id FROM trunk_incidents WHERE workspace_id = ${w.workspaceId}::uuid`)).toEqual([]);
  });
});

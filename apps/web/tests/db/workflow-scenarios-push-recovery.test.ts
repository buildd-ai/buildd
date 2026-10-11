/**
 * Named incident scenarios, push-recovery half (spec §9: a local commit is
 * never delivery; push_recovery is bounded, 3 tries then T22
 * ESCALATED(push_undeliverable); §4: every non-terminal state has an owner of
 * its next move). The real kernel on real Postgres against the stateful fake
 * GitHub; see workflow-scenarios-world.ts. The test name is the sequence and
 * the outcome.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';
import { seam, world, type World } from './workflow-scenarios-world';

let w: World;
afterEach(() => w?.dispose());

type Pr = Awaited<ReturnType<World['openPr']>>;

/** The fix task the request-changes dispatched, as the claim route hands it to the seam. */
async function fixTaskOf(w: World, pr: Pr) {
  const [t] = await w.tasksOf(pr, 'fix');
  if (!t) throw new Error('no fix task filed');
  return { id: t.id, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'fix', context: t.context };
}

async function worker(w: World, taskId: string, branch: string, sha: string | null, commits: number): Promise<string> {
  const [r] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, commit_count)
    VALUES (${w.workspaceId}::uuid, ${taskId}::uuid, 'wk', 'test', ${branch}, 'completed', ${sha}, ${commits}) RETURNING id`);
  return r.id;
}

/** Time passes: every pending effect of the delivery comes due and the drain runs it. Once. */
async function tick(pr: Pr): Promise<void> {
  await q(sql`UPDATE workflow_effects SET not_before = now() - interval '1 second' WHERE delivery_id = ${pr.deliveryId}::uuid AND status = 'pending'`);
  await seam.drainDelivery(pr.deliveryId);
}

const pending = async (w: World, pr: Pr) => (await w.effects(pr)).filter((e) => e.kind === 'push_recovery' && (e.status === 'pending' || e.status === 'delivering'));

describe('a fix attempt that pushes its own work (abe42d1b)', () => {
  test('changes requested at H1; the fix agent pushes H2 to the PR itself and ends with nothing local → the attempt is delivered by its own push: round 2 at H2, no push recovery', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/self-push', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    expect(await w.verdict(pr, await w.reviewer(pr), 'request_changes', pr.head)).toMatchObject({ toState: 'CHANGES_REQUESTED' });
    const fix = await fixTaskOf(w, pr);
    expect(await seam.claimFix(fix)).toEqual({ action: 'proceed' });

    // The agent pushes from its session: the head webhook arrives while FIXING and is the attempt's.
    const h2 = w.gh.push(w.repo, pr.branch, { 'src/a.ts': 'export const a = 3;\n' });
    await w.deliver();
    let v = await w.view(pr);
    expect(v.delivery).toMatchObject({ state: 'FIXING', currentHeadSha: h2 });
    expect(v.attempts.find((a) => a.family === 'review_fix')?.reportedShas).toEqual([h2]);

    // The runner has no local commits and so no local head to report.
    const wk = await worker(w, fix.id, pr.branch, null, 0);
    await seam.attemptEnded({ task: fix, workerId: wk, status: 'completed', localHeadSha: null, commitCount: 0, source: 'runner' });
    v = await w.view(pr);
    expect(v.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: h2 });
    expect(v.rounds.map((r) => [r.round, r.headSha, r.kind])).toEqual([[1, pr.head, 'full'], [2, h2, 'delta']]);
    expect(v.attempts.find((a) => a.family === 'review_fix')).toMatchObject({ status: 'ended', outcome: 'delivered' });
    expect((await w.effects(pr)).filter((e) => e.kind === 'push_recovery')).toEqual([]);
    // The floor owes nothing beside it (no second recovery chain under the attempt's head).
    await w.floor(pr);
    expect((await w.effects(pr)).filter((e) => e.kind === 'push_recovery')).toEqual([]);
    expect((await w.reviewer(pr)).context.headSha).toBe(h2);
  });

  test('a fix that ends with nothing local and no push of its own is still AWAITING_PUSH, and its recovery escalates after the bounded tries', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/no-push', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    await w.verdict(pr, await w.reviewer(pr), 'request_changes', pr.head);
    const fix = await fixTaskOf(w, pr);
    await seam.claimFix(fix);
    const wk = await worker(w, fix.id, pr.branch, null, 0);
    await seam.attemptEnded({ task: fix, workerId: wk, status: 'completed', localHeadSha: null, commitCount: 0, source: 'runner' });
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_PUSH', currentHeadSha: pr.head });
    for (let i = 0; i < 5 && (await w.delivery(pr)).state === 'AWAITING_PUSH'; i++) await tick(pr);
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'push_undeliverable' });
  });
});

describe('push recovery after an unproven head move (9e27996d)', () => {
  test('the owner ends with a local-only commit L; try 1 sees nothing; the branch is force-pushed to H2 without L and no webhook arrives; try 2 sees H2 → recovery continues and still ends in ESCALATED(push_undeliverable), never a silent AWAITING_PUSH', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/lost-push', files: { 'src/a.ts': 'export const a = 2;\n' } });
    // The owner commits L on a branch GitHub has, but the PR head never moves to it.
    w.gh.createBranch(w.repo, 'local/lost-push', pr.branch);
    const local = w.gh.push(w.repo, 'local/lost-push', { 'src/a.ts': 'export const a = 3;\n' });
    w.gh.discardWebhooks();
    await q(sql`UPDATE workers SET status = 'completed', last_commit_sha = ${local} WHERE id = ${pr.workerId}::uuid`);
    await seam.attemptEnded({
      task: { id: pr.ownerTaskId, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null },
      workerId: pr.workerId, status: 'completed', localHeadSha: local, commitCount: 1, source: 'runner',
    });
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_PUSH', currentHeadSha: pr.head });

    // Try 1: nothing moved, try 2 is scheduled.
    await tick(pr);
    expect((await w.effects(pr)).find((e) => e.dedupe_key.endsWith(`:${local}:1`))).toMatchObject({ status: 'done', outcome: 'ok:retry_2' });

    // Someone force-pushes the PR branch to H2, which does not contain L. The webhook is lost.
    const h2 = w.gh.forcePush(w.repo, pr.branch, { changes: { 'src/b.ts': 'export const b = 9;\n' } });
    w.gh.discardWebhooks();
    expect(w.gh.isAncestor(w.repo, local, h2)).toBe(false);

    // Time keeps passing. Every AWAITING_PUSH must have a live recovery try until it leaves the state.
    for (let i = 0; i < 8 && (await w.delivery(pr)).state === 'AWAITING_PUSH'; i++) {
      await tick(pr);
      const d = await w.delivery(pr);
      if (d.state === 'AWAITING_PUSH') expect((await pending(w, pr)).length).toBeGreaterThan(0);
    }
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'push_undeliverable', currentHeadSha: h2 });
    expect((await w.commands(pr)).at(-1)).toBe('PushRecoveryExhausted');
    // Bounded: the restarted chain spent at most its own three tries.
    const chain = (await w.effects(pr)).filter((e) => e.kind === 'push_recovery');
    expect(chain.length).toBeLessThanOrEqual(6);
  });

  test('floor: an AWAITING_PUSH whose recovery chain is all done (none pending, none dead) owes the final try, which is T22', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/limbo', files: { 'src/a.ts': 'export const a = 2;\n' } });
    w.gh.createBranch(w.repo, 'local/limbo', pr.branch);
    const local = w.gh.push(w.repo, 'local/limbo', { 'src/a.ts': 'export const a = 3;\n' });
    w.gh.discardWebhooks();
    await q(sql`UPDATE workers SET status = 'completed' WHERE id = ${pr.workerId}::uuid`);
    await seam.attemptEnded({
      task: { id: pr.ownerTaskId, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null },
      workerId: pr.workerId, status: 'completed', localHeadSha: local, commitCount: 1, source: 'runner',
    });
    // The chain ended without an exit (a follow-up that never got inserted): every try done.
    await q(sql`UPDATE workflow_effects SET status = 'done', outcome = 'ok:retry_2' WHERE delivery_id = ${pr.deliveryId}::uuid AND kind = 'push_recovery'`);
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_PUSH' });
    await w.floor(pr);
    await tick(pr);
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'push_undeliverable' });
  });
});

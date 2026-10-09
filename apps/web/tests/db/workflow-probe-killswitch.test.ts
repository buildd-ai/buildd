/**
 * Adversarial probe (lens 4): the gitConfig.workflowKernel kill switch and the
 * legacy paths around it. Real kernel, real Postgres, stateful fake GitHub
 * (workflow-scenarios-world.ts). Each test states the behaviour the spec
 * (docs/specs/workflow-state-kernel.md §14, AC-11, S22) promises.
 *
 * Every finding test asserts the CORRECT behaviour and is marked `test.failing`
 * because it fails on dev today (probe task e769323f). Bun reports a
 * `test.failing` that starts passing as a failure, so the PR that fixes a
 * finding must turn its test(s) back into plain `test`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';
import { seam, world, type World } from './workflow-scenarios-world';

let w: World;
afterEach(() => w?.dispose());

const updateBranchCalls = (w: World, prNumber: number) =>
  w.gh.calls.filter((c) => c.method === 'PUT' && c.path === `/repos/${w.repo}/pulls/${prNumber}/update-branch`);

async function switchOff(workspaceId: string, value: unknown = false): Promise<void> {
  await q(sql`UPDATE workspaces SET git_config = jsonb_set(COALESCE(git_config, '{}'::jsonb), '{workflowKernel}', ${JSON.stringify(value)}::jsonb) WHERE id = ${workspaceId}::uuid`);
}

const noDrain = { drain: async () => null };

describe('kill switch: effects queued before the switch', () => {
  test.failing('a merge_call queued before the switch is turned off, answered "behind" after it → the kernel makes a NEW decision (refresh) and pushes to the PR branch while switched off', async () => {
    w = await world();
    w.gh.protect(w.repo, 'dev', { strict: true });
    const pr = await w.openPr({ branch: 'feat/ks-behind', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    // The landing door's transition commits; its inline drain does not run (crash / timeout).
    const landed = await seam.landThroughKernel({ workspaceId: w.workspaceId, installationId: w.installationId, repoFullName: w.repo, prNumber: pr.prNumber, headSha: pr.head, door: 'auto_merge', actor: 'system:auto_merge' }, noDrain);
    expect(landed).toMatchObject({ outcome: 'landing' });
    expect((await w.delivery(pr)).state).toBe('LANDING');

    // Emergency: the operator turns the kernel off. The base moves meanwhile.
    await switchOff(w.workspaceId);
    w.gh.advanceBase(w.repo, 'dev', { 'src/b.ts': 'export const b = 2;\n' });

    // The cron's outbox floor drains due effects (same runEffects, no authority filter).
    await seam.drainDelivery(pr.deliveryId);

    // While switched off the kernel must not decide anything new: no branch rewrite, no REPAIRING.
    const cmds = await w.commands(pr);
    expect({ updateBranch: updateBranchCalls(w, pr.prNumber).length, lastCommand: cmds[cmds.length - 1], state: (await w.delivery(pr)).state })
      .toEqual({ updateBranch: 0, lastCommand: 'LandingRequested', state: 'LANDING' });
  });

  test.failing('a merge_call still pending when the switch goes off → the kernel merges the PR after the operator turned it off', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/ks-merge', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    await seam.landThroughKernel({ workspaceId: w.workspaceId, installationId: w.installationId, repoFullName: w.repo, prNumber: pr.prNumber, headSha: pr.head, door: 'auto_merge', actor: 'system:auto_merge' }, noDrain);
    await switchOff(w.workspaceId);
    // Something legacy touches the PR first: the delivery is released (sticky).
    expect(await seam.kernelDeliveryOfPr({ workspaceId: w.workspaceId, prNumber: pr.prNumber })).toBeNull();
    const [{ authority }] = await q<{ authority: string }>(sql`SELECT authority FROM workflow_deliveries WHERE id = ${pr.deliveryId}::uuid`);
    expect(authority).toBe('legacy');

    await seam.drainDelivery(pr.deliveryId);
    expect({ mergeCalls: w.mergeCalls(pr).length, merged: w.gh.pr(w.repo, pr.prNumber).merged }).toEqual({ mergeCalls: 0, merged: false });
  });
});

describe('kill switch: sweeps that read deliveries without resolving authority', () => {
  test.failing('trunk recovery sweep with the kill switch off → TrunkRecovered is applied and the PR branch refreshed by the kernel, the delivery never released', async () => {
    w = await world();
    const a = await w.openPr({ branch: 'feat/ks-red-a', files: { 'src/a.ts': 'export const a = 2;\n' } });
    const b = await w.openPr({ branch: 'feat/ks-red-b', files: { 'src/c.ts': 'export const c = 2;\n' } });
    await w.handOn(a);
    await w.handOn(b);
    const devHead = w.gh.branchHead(w.repo, 'dev')!;
    w.gh.setCheck(w.repo, devHead, 'lint', { conclusion: 'failure' });
    w.gh.setCheck(w.repo, a.head, 'lint', { conclusion: 'failure' });
    await w.deliver();
    w.gh.setCheck(w.repo, b.head, 'lint', { conclusion: 'failure' });
    await w.deliver();
    const blocked = [];
    for (const p of [a, b]) if ((await w.delivery(p)).state === 'BLOCKED_ON_TRUNK') blocked.push(p);
    expect(blocked.length).toBeGreaterThan(0);

    await switchOff(w.workspaceId);
    const fixed = w.gh.advanceBase(w.repo, 'dev', { 'src/fix.ts': 'export const fixed = true;\n' });
    w.gh.greenCi(w.repo, fixed, ['lint']);
    // Cron tick, with webhooks for the base move not reaching any seam yet.
    await seam.reconcileTrunkIncidents();

    for (const p of blocked) {
      const [{ authority }] = await q<{ authority: string }>(sql`SELECT authority FROM workflow_deliveries WHERE id = ${p.deliveryId}::uuid`);
      const d = await w.delivery(p);
      expect({ pr: p.prNumber, state: d.state, updateBranch: updateBranchCalls(w, p.prNumber).length, authority })
        .toEqual({ pr: p.prNumber, state: 'BLOCKED_ON_TRUNK', updateBranch: 0, authority: expect.any(String) });
    }
  });
});

describe('kill switch: value forms', () => {
  test.failing('workflowKernel: "false" (string) → openKernelDelivery claims the PR (owned: true, so the caller dispatches no first review) yet every later touch releases it to legacy', async () => {
    w = await world({ gitConfig: { workflowKernel: 'false' } });
    // openPr needs a delivery to exist; drive the door by hand instead.
    const ownerTaskId = (await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status) VALUES (${w.workspaceId}::uuid, 'feat: str-false', 'in_progress') RETURNING id`))[0].id;
    w.gh.createBranch(w.repo, 'feat/str-false', 'dev');
    const head = w.gh.push(w.repo, 'feat/str-false', { 'src/a.ts': 'export const a = 3;\n' }, { message: 'x' });
    const prNumber = w.gh.openPr(w.repo, { head: 'feat/str-false', base: 'dev', title: 'feat: str-false' });
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, commit_count)
      VALUES (${w.workspaceId}::uuid, ${ownerTaskId}::uuid, 'w', 'test', 'feat/str-false', 'running', ${head}, ${prNumber}, ${`https://github.com/${w.repo}/pull/${prNumber}`}, 1)`);
    const opened = await seam.openKernelDelivery({ workspaceId: w.workspaceId, ownerTaskId, repoFullName: w.repo, prNumber, installationId: w.installationId, source: 'webhook:opened' });
    const rows = await q<{ authority: string }>(sql`SELECT authority FROM workflow_deliveries WHERE workspace_id = ${w.workspaceId}::uuid`);
    // One reading of the switch: either the door declines (kernel_off) and legacy reviews, or the kernel keeps the PR.
    expect({ owned: opened.owned, authorities: rows.map((r) => r.authority) })
      .toEqual({ owned: false, authorities: [] });
  });

  test.failing('workflowKernel: "false" (string) → the PR the door claimed is released when its owner attempt ends, and nobody ever files its first review', async () => {
    w = await world({ gitConfig: { workflowKernel: 'false' } });
    const ownerTaskId = (await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status) VALUES (${w.workspaceId}::uuid, 'feat: str-false-2', 'in_progress') RETURNING id`))[0].id;
    w.gh.createBranch(w.repo, 'feat/str-false-2', 'dev');
    const head = w.gh.push(w.repo, 'feat/str-false-2', { 'src/a.ts': 'export const a = 4;\n' }, { message: 'x' });
    const prNumber = w.gh.openPr(w.repo, { head: 'feat/str-false-2', base: 'dev', title: 'feat: str-false-2' });
    const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, commit_count)
      VALUES (${w.workspaceId}::uuid, ${ownerTaskId}::uuid, 'w', 'test', 'feat/str-false-2', 'running', ${head}, ${prNumber}, ${`https://github.com/${w.repo}/pull/${prNumber}`}, 1) RETURNING id`);
    const opened = await seam.openKernelDelivery({ workspaceId: w.workspaceId, ownerTaskId, repoFullName: w.repo, prNumber, installationId: w.installationId, source: 'webhook:opened' });
    expect(opened.owned).toBe(true); // reviewer-subscribers: `if (kernel.owned) return true` — no legacy reviewer filed
    // The owner attempt ends (worker PATCH → seam.attemptEnded).
    await q(sql`UPDATE workers SET status = 'completed' WHERE id = ${wk.id}::uuid`);
    const [t] = await q<{ delivery_id: string | null; delivery_role: string | null }>(sql`SELECT delivery_id, delivery_role FROM tasks WHERE id = ${ownerTaskId}::uuid`);
    const ended = await seam.attemptEnded({
      task: { id: ownerTaskId, workspaceId: w.workspaceId, deliveryId: t.delivery_id, deliveryRole: t.delivery_role, context: null },
      workerId: wk.id, status: 'completed', localHeadSha: head, commitCount: 1, source: 'runner',
    });
    const [d] = await q<{ authority: string; state: string }>(sql`SELECT authority, state FROM workflow_deliveries WHERE workspace_id = ${w.workspaceId}::uuid`);
    const reviewers = await q(sql`SELECT id FROM tasks WHERE workspace_id = ${w.workspaceId}::uuid AND (category = 'review' OR delivery_role = 'review')`);
    expect({ handled: ended.handled, authority: d.authority, state: d.state, reviewers: reviewers.length })
      .toEqual({ handled: true, authority: 'kernel', state: 'AWAITING_REVIEW', reviewers: 1 });
  });
});

describe('kill switch: flipped while the owner is still working', () => {
  test.failing('PR opened with the kernel on (legacy first review skipped), switch turned off before the owner ends → the owner end releases the delivery and nothing ever files a review: the PR is stranded open', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/ks-strand', files: { 'src/a.ts': 'export const a = 5;\n' } });
    expect((await w.delivery(pr)).state).toBe('WORKING');
    await switchOff(w.workspaceId);
    await q(sql`UPDATE workers SET status = 'completed' WHERE id = ${pr.workerId}::uuid`);
    const ended = await seam.attemptEnded({
      task: { id: pr.ownerTaskId, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null },
      workerId: pr.workerId, status: 'completed', localHeadSha: pr.head, commitCount: 1, source: 'runner',
    });
    // Nothing else is coming: the legacy first review was dispatched only at PR open (skipped because the kernel owned it),
    // and the landing backstop that re-asks for a never-requested review runs only with landing.mode=enforce.
    await seam.reconcileKernelDeliveries({}, { only: [pr.deliveryId], minQuietMs: 0 });
    const reviewers = await q(sql`SELECT id FROM tasks WHERE workspace_id = ${w.workspaceId}::uuid AND (category = 'review' OR delivery_role = 'review')`);
    const [d] = await q<{ authority: string; state: string }>(sql`SELECT authority, state FROM workflow_deliveries WHERE id = ${pr.deliveryId}::uuid`);
    expect({ handled: ended.handled, authority: d.authority, state: d.state, reviewers: reviewers.length, prOpen: w.gh.pr(w.repo, pr.prNumber).state })
      .toEqual({ handled: false, authority: 'legacy', state: 'WORKING', reviewers: 1, prOpen: 'open' });
  });
});


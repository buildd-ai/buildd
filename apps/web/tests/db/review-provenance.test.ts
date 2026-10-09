/**
 * Reviewer identity comes from server state. A verdict acts on a PR (posts a
 * GitHub review, runs the self-merge) only when the review system dispatched
 * the reviewer task, for a PR of that task's own workspace, through that
 * workspace's linked repo and installation. Fields a caller wrote into a
 * task's context never name the reviewed task, the repo or the installation.
 *
 * Real Postgres, the real task-creation and worker routes with real API-key
 * auth (only the session lookup is stubbed, so the bearer path runs), and the
 * stateful fake GitHub.
 */
import { seam, world, type World } from './workflow-scenarios-world';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { q, seedWorkspace } from './harness';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

const tasksRoute = await import('../../src/app/api/tasks/route');
const workersRoute = await import('../../src/app/api/workers/[id]/route');

let w: World | undefined;
afterEach(() => w?.dispose());

async function serviceKey(teamId: string, level: 'worker' | 'admin' = 'worker'): Promise<{ id: string; key: string }> {
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hashed = createHash('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level)
    VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${hashed}, ${teamId}::uuid, ${level}) RETURNING id`);
  return { id: a.id, key };
}

function req(method: string, path: string, key: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type Pr = Awaited<ReturnType<World['openPr']>>;

function reviewContext(w: World, pr: Pr, head: string): Record<string, unknown> {
  return {
    reviewerFor: pr.ownerTaskId,
    workflowRoundId: crypto.randomUUID(),
    prNumber: pr.prNumber,
    headSha: head,
    repoFullName: w.repo,
    installationId: w.installationId,
    prUrl: `https://github.com/${w.repo}/pull/${pr.prNumber}`,
    workerBranch: pr.branch,
    iteration: 0,
    maxIterations: 3,
  };
}

/** File a task through POST /api/tasks with `key`, then complete it with an approve verdict. */
async function fileAndApprove(o: { workspaceId: string; account: { id: string; key: string }; context: Record<string, unknown> }) {
  const created = await tasksRoute.POST(req('POST', '/api/tasks', o.account.key, {
    workspaceId: o.workspaceId, title: 'review', description: 'review', category: 'review',
    kind: 'research', outputRequirement: 'none', context: o.context,
  }) as never);
  const body = await created.json() as { id?: string; task?: { id: string }; error?: string };
  if (created.status >= 300) throw new Error(`create ${created.status} ${JSON.stringify(body)}`);
  const taskId = (body.id ?? body.task?.id)!;
  await q(sql`UPDATE tasks SET status = 'in_progress' WHERE id = ${taskId}::uuid`);
  return { taskId, ...(await completeWithApprove({ workspaceId: o.workspaceId, taskId, account: o.account })) };
}

async function completeWithApprove(o: { workspaceId: string; taskId: string; account: { id: string; key: string } }) {
  const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, account_id, name, runner, branch, status)
    VALUES (${o.workspaceId}::uuid, ${o.taskId}::uuid, ${o.account.id}::uuid, 'w', 'test', 'none', 'running') RETURNING id`);
  const patched = await workersRoute.PATCH(
    req('PATCH', `/api/workers/${wk.id}`, o.account.key, { status: 'completed', structuredOutput: { verdict: 'approve', confidence: 0.99, summary: 'lgtm' } }) as never,
    { params: Promise.resolve({ id: wk.id }) } as never,
  );
  return { status: patched.status };
}

function outcome(w: World, pr: Pr) {
  const live = w.gh.pr(w.repo, pr.prNumber);
  return {
    approvals: live.reviews.filter((r: { state: string }) => r.state === 'APPROVED').length,
    merged: live.merged,
    mergeCalls: w.mergeCalls(pr).length,
  };
}

describe('reviewer identity comes from server state', () => {
  test('context keys the review system owns are not stored on a task filed through the API', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/keys', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${w.workspaceId}::uuid`);
    const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w.workspaceId}::uuid`);
    const account = await serviceKey(ws.team_id);
    const created = await tasksRoute.POST(req('POST', '/api/tasks', account.key, {
      workspaceId: w.workspaceId, title: 'look at it', description: 'x', category: 'review', kind: 'research', outputRequirement: 'none',
      context: { ...reviewContext(w, pr, pr.head), baseBranch: 'dev', failureContext: 'kept' },
    }) as never);
    const body = await created.json() as { id?: string; task?: { id: string } };
    expect(created.status).toBeLessThan(300);
    const [row] = await q<{ context: Record<string, unknown> }>(sql`SELECT context FROM tasks WHERE id = ${(body.id ?? body.task?.id)!}::uuid`);
    expect(row.context.reviewerFor).toBeUndefined();
    expect(row.context.workflowRoundId).toBeUndefined();
    // Ordinary caller context is untouched.
    expect(row.context.baseBranch).toBe('dev');
    expect(row.context.failureContext).toBe('kept');
  }, 60_000);

  test('a verdict from a task filed in another team posts no review on the PR it names', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/other-team', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');

    const { teamId, workspaceId } = await seedWorkspace();
    await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${workspaceId}::uuid`);
    const account = await serviceKey(teamId);
    await fileAndApprove({ workspaceId, account, context: reviewContext(w, pr, w.gh.pr(w.repo, pr.prNumber).headSha) });
    await w.deliver();

    expect(outcome(w, pr)).toEqual({ approvals: 0, merged: false, mergeCalls: 0 });
  }, 60_000);

  test('a verdict acts only through the repo linked to its own workspace, whatever its row names', async () => {
    // The row is written as the review system would write it, but in a
    // workspace of another team: the verdict resolves repo and installation
    // from that workspace (none here), and the reviewed task is not in it.
    w = await world();
    const pr = await w.openPr({ branch: 'feat/row', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    const { teamId, workspaceId } = await seedWorkspace();
    const account = await serviceKey(teamId);
    const ctx = reviewContext(w, pr, w.gh.pr(w.repo, pr.prNumber).headSha);
    delete ctx.workflowRoundId;
    const [t] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, title, status, category, context, parent_task_id, task_class, creation_source)
      VALUES (${workspaceId}::uuid, 'review', 'in_progress', 'review', ${JSON.stringify(ctx)}::jsonb, ${pr.ownerTaskId}::uuid, 'attempt', 'webhook')
      RETURNING id`);
    await completeWithApprove({ workspaceId, taskId: t.id, account });
    await w.deliver();

    expect(outcome(w, pr)).toEqual({ approvals: 0, merged: false, mergeCalls: 0 });
  }, 60_000);

  test('a verdict from a task filed in the PR\'s own workspace neither reviews nor lands a PR the kernel does not own', async () => {
    w = await world({ gitConfig: { mergePolicy: { tier: 'agent-review' } } });
    const pr = await w.openPr({ branch: 'feat/self', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await q(sql`UPDATE workspaces SET git_config = git_config || '{"workflowKernel": false}'::jsonb, access_mode = 'open' WHERE id = ${w.workspaceId}::uuid`);
    const head = w.gh.pr(w.repo, pr.prNumber).headSha;
    w.gh.greenCi(w.repo, head, ['build', 'test']);
    await w.deliver();
    const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w.workspaceId}::uuid`);
    const account = await serviceKey(ws.team_id);
    const ctx = reviewContext(w, pr, head);
    delete ctx.workflowRoundId;
    await fileAndApprove({ workspaceId: w.workspaceId, account, context: ctx });
    await w.deliver();

    expect(outcome(w, pr)).toEqual({ approvals: 0, merged: false, mergeCalls: 0 });
  }, 60_000);

  test('a verdict from a task filed in the PR\'s own workspace posts no review on a kernel-owned PR', async () => {
    w = await world({ gitConfig: { mergePolicy: { tier: 'agent-review' } } });
    const pr = await w.openPr({ branch: 'feat/self-kernel', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${w.workspaceId}::uuid`);
    const head = w.gh.pr(w.repo, pr.prNumber).headSha;
    w.gh.greenCi(w.repo, head, ['build', 'test']);
    await w.deliver();
    const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w.workspaceId}::uuid`);
    const account = await serviceKey(ws.team_id);
    const ctx = reviewContext(w, pr, head);
    delete ctx.workflowRoundId;
    await fileAndApprove({ workspaceId: w.workspaceId, account, context: ctx });
    await w.deliver();

    expect(outcome(w, pr)).toEqual({ approvals: 0, merged: false, mergeCalls: 0 });
  }, 60_000);

  test('a reviewer row the review system wrote for a kernel-owned PR, but outside its rounds, posts no review', async () => {
    // A legacy-shaped reviewer row (no delivery, no round) for a PR the kernel
    // owns: the verdict is the kernel's to take, so the legacy path stays out.
    w = await world({ gitConfig: { mergePolicy: { tier: 'agent-review' } } });
    const pr = await w.openPr({ branch: 'feat/legacy-row', files: { 'src/a.ts': 'export const a = 2;\n' } });
    const head = w.gh.pr(w.repo, pr.prNumber).headSha;
    w.gh.greenCi(w.repo, head, ['build', 'test']);
    await w.deliver();
    const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w.workspaceId}::uuid`);
    const account = await serviceKey(ws.team_id);
    const ctx = reviewContext(w, pr, head);
    delete ctx.workflowRoundId;
    const [t] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, title, status, category, context, parent_task_id, task_class, creation_source)
      VALUES (${w.workspaceId}::uuid, 'review', 'in_progress', 'review', ${JSON.stringify(ctx)}::jsonb, ${pr.ownerTaskId}::uuid, 'attempt', 'webhook')
      RETURNING id`);
    await completeWithApprove({ workspaceId: w.workspaceId, taskId: t.id, account });
    await w.deliver();

    expect(outcome(w, pr)).toEqual({ approvals: 0, merged: false, mergeCalls: 0 });
  }, 60_000);

  test('a kernel review round still posts its verdict and lands the PR', async () => {
    // Control: the review system's own round is unaffected.
    w = await world();
    const pr = await w.openPr({ branch: 'feat/control', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    w.gh.greenCi(w.repo, pr.head, ['build', 'test']);
    await w.deliver();
    const rv = await w.reviewer(pr);
    const v = await seam.recordReviewVerdict({ reviewerTask: { id: rv.id, deliveryId: pr.deliveryId, context: rv.context }, verdict: 'approve', effectiveVerdict: 'approve', headSha: pr.head, confidence: 0.95 });
    expect(v.handled).toBe(true);
    await w.deliver();
    expect((await w.delivery(pr)).state).toMatch(/APPROVED|LANDING|MERGED/);
  }, 60_000);
});

/**
 * The kernel against the stateful fake GitHub (apps/web/src/lib/workflow/testing/fake-github.ts),
 * on real Postgres: a PR opened, CI green, reviewed and approved, landed and merged.
 *
 * Unlike workflow-matrix.test.ts nothing GitHub-shaped is stubbed per call: the
 * production reader, `mergePullRequest`, `postPrReview` and the effect handlers
 * all speak HTTP to the fake through `fetch` (the installation token comes from
 * the seeded token cache), and the production composition root drains the
 * outbox. Webhooks are hints (R2): the fake raises them with GitHub's payload
 * shapes and `ingest` hands them to the seam functions the webhook route and
 * the PR subscribers call; the kernel then takes its own read.
 *
 * Only the leaves that are not GitHub are faked: the reviewer prompt (a task
 * row linked to the round), the dispatch wake and team notifications.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const realReviewer = await import('../../src/lib/reviewer');
let workspaceId: string;
mock.module('../../src/lib/reviewer', () => ({
  ...realReviewer,
  createReviewerTask: async (p: { workflowRound: { deliveryId: string; roundId: string; round: number }; headSha: string }) => {
    const taskId = await seedTask(workspaceId, { status: 'pending', title: `review r${p.workflowRound.round}` });
    await q(sql`UPDATE tasks SET delivery_id = ${p.workflowRound.deliveryId}::uuid, delivery_role = 'review', category = 'review',
      context = jsonb_build_object('workflowRoundId', ${p.workflowRound.roundId}::text, 'headSha', ${p.headSha}::text) WHERE id = ${taskId}::uuid`);
    return { id: taskId };
  },
}));
const realDispatch = await import('../../src/lib/dispatch-authority');
mock.module('../../src/lib/dispatch-authority', () => ({ ...realDispatch, announceTaskCreated: async () => {}, wakeTask: async () => {} }));
const realNotify = await import('../../src/lib/notify');
mock.module('../../src/lib/notify', () => ({ ...realNotify, notifyTeamOf: async () => {} }));
const realScope = await import('../../src/lib/pr-scope-reconcile-trigger');
mock.module('../../src/lib/pr-scope-reconcile-trigger', () => ({ ...realScope, schedulePrScopeReconcile: () => {} }));
const realReviewRequest = await import('../../src/lib/pr-review-request');
mock.module('../../src/lib/pr-review-request', () => ({ ...realReviewRequest, listWorkspaceRoles: async () => [{ slug: 'reviewer' }] }));

const { FakeGithub } = await import('../../src/lib/workflow/testing/fake-github');
type WebhookDelivery = import('../../src/lib/workflow/testing/fake-github').WebhookDelivery;
const seam = await import('../../src/lib/workflow/seam');
const { loadView } = await import('../../src/lib/workflow/kernel');
const { githubReader } = await import('../../src/lib/workflow/github-facts');

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const REPO = `acme/fake-${RUN}`;
const BRANCH = 'feat/smoke';
let installationId: number;
let gh: InstanceType<typeof FakeGithub>;
let restoreFetch: () => void;
/** Owner task per head branch: what create_pr knows when it opens the delivery. */
const ownerByBranch = new Map<string, string>();
const ingested: string[] = [];

/**
 * The webhook route's and the PR subscribers' mapping from a GitHub event to
 * the kernel seam, keyed on the payload the way they read it.
 */
async function ingest(d: WebhookDelivery): Promise<void> {
  const p = d.payload as Record<string, any>;
  const repoFullName = String(p.repository.full_name);
  const base = { workspaceId, repoFullName, installationId: Number(p.installation.id) };
  ingested.push(`${d.name}.${p.action ?? p.ref}`);
  if (d.name !== 'pull_request') return;
  const prNumber = Number(p.number);
  switch (p.action) {
    case 'opened': {
      const ownerTaskId = ownerByBranch.get(String(p.pull_request.head.ref));
      if (ownerTaskId) await seam.openKernelDelivery({ ...base, ownerTaskId, prNumber, source: 'webhook:opened' });
      return;
    }
    case 'synchronize':
      await seam.observeHead({ ...base, prNumber, hintedHeadSha: String(p.after ?? p.pull_request.head.sha), source: 'webhook:synchronize' });
      return;
    case 'closed':
    case 'reopened':
      await seam.observePrState({ ...base, prNumber, source: `webhook:${p.action}` });
  }
}

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
  installationId = Math.floor(Math.random() * 1e12);
  // A cached, unexpired token: getInstallationToken answers from the row and never signs a JWT.
  const [inst] = await q<{ id: string }>(sql`INSERT INTO github_installations (installation_id, account_type, account_login, account_id, access_token, token_expires_at)
    VALUES (${installationId}, 'Organization', 'acme', ${installationId}, 'ghs_fake', now() + interval '1 day') RETURNING id`);
  const [repo] = await q<{ id: string }>(sql`INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner, default_branch)
    VALUES (${inst.id}::uuid, ${installationId}, ${REPO}, ${REPO.split('/')[1]}, 'acme', 'dev') RETURNING id`);
  await q(sql`UPDATE workspaces SET github_installation_id = ${inst.id}::uuid, github_repo_id = ${repo.id}::uuid WHERE id = ${workspaceId}::uuid`);

  gh = new FakeGithub({ installationId, seed: 42 });
  restoreFetch = gh.installFetch();
  gh.onWebhook(ingest);
  gh.createRepo(REPO, { defaultBranch: 'dev', files: { 'src/a.ts': 'export const a = 1;\n' } });
  await gh.deliverWebhooks();
});
afterAll(() => restoreFetch?.());

const transitions = (deliveryId: string) => q<{ command: string; to_state: string }>(
  sql`SELECT command, to_state FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid ORDER BY to_version`);

describe('the kernel against the fake GitHub', () => {
  test('smoke: open PR → CI green → review approve → land → merged', async () => {
    // The owner's worker pushes its branch and opens the PR.
    const ownerTaskId = await seedTask(workspaceId, { status: 'in_progress', title: 'feat: smoke' });
    ownerByBranch.set(BRANCH, ownerTaskId);
    const h1 = gh.push(REPO, BRANCH, { 'src/a.ts': 'export const a = 2;\n' });
    const prNumber = gh.openPr(REPO, { head: BRANCH, base: 'dev', title: 'feat: smoke' });
    const prUrl = `https://github.com/${REPO}/pull/${prNumber}`;
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, commit_count)
      VALUES (${workspaceId}::uuid, ${ownerTaskId}::uuid, 'w', 'test', ${BRANCH}, 'running', ${h1}, ${prNumber}, ${prUrl}, 1)`);
    await gh.deliverWebhooks();
    const deliveryId = (await seam.kernelDeliveryOfPr({ workspaceId, prNumber }))?.deliveryId;
    expect(deliveryId).toBeTruthy();
    let d = (await loadView({ deliveryId: deliveryId! })).delivery!;
    expect(d).toMatchObject({ repoFullName: REPO, prNumber, currentHeadSha: h1, baseRef: 'dev' });

    // The owner attempt ends with its head on GitHub: a review round is dispatched.
    const [w] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, commit_count)
      VALUES (${workspaceId}::uuid, ${ownerTaskId}::uuid, 'w', 'test', ${BRANCH}, 'completed', ${h1}, ${prNumber}, ${prUrl}, 1) RETURNING id`);
    const ended = await seam.attemptEnded({
      task: { id: ownerTaskId, workspaceId, deliveryId: deliveryId!, deliveryRole: 'owner', context: null },
      workerId: w.id, status: 'completed', localHeadSha: h1, commitCount: 1, source: 'runner',
    });
    expect(ended.handled).toBe(true);
    expect((await loadView({ deliveryId: deliveryId! })).delivery!.state).toBe('AWAITING_REVIEW');

    // CI goes green on the head.
    gh.greenCi(REPO, h1, ['build', 'test']);
    await gh.deliverWebhooks();
    const reader = githubReader(installationId);
    expect(await reader.ciGreen!(REPO, h1)).toBe(true);

    // The reviewer approves the head; the verdict is posted to GitHub as a review on it.
    const [reviewer] = await q<{ id: string; context: Record<string, unknown> }>(
      sql`SELECT id, context FROM tasks WHERE delivery_id = ${deliveryId}::uuid AND delivery_role = 'review' ORDER BY created_at DESC LIMIT 1`);
    expect(reviewer).toBeTruthy();
    await seam.recordReviewVerdict({
      reviewerTask: { id: reviewer.id, workspaceId, deliveryId: deliveryId!, deliveryRole: 'review', context: reviewer.context },
      verdict: 'approve', effectiveVerdict: 'approve', headSha: h1, confidence: 0.9,
    });
    expect((await loadView({ deliveryId: deliveryId! })).delivery!.state).toBe('APPROVED');
    expect(gh.pr(REPO, prNumber).reviews).toEqual([expect.objectContaining({ state: 'APPROVED', commitId: h1, user: gh.appLogin })]);
    await gh.deliverWebhooks();

    // A door lands it, its rails having read CI green; the kernel makes the one pinned merge call.
    const landed = await seam.landThroughKernel({ workspaceId, installationId, repoFullName: REPO, prNumber, headSha: h1, door: 'auto_merge', actor: 'system:auto_merge' });
    expect(landed).toMatchObject({ merged: true, outcome: 'merged' });
    const merges = gh.calls.filter((c) => c.method === 'PUT' && c.path.endsWith(`/pulls/${prNumber}/merge`));
    expect(merges).toEqual([{ method: 'PUT', path: `/repos/${REPO}/pulls/${prNumber}/merge`, status: 200 }]);

    // GitHub: merged, the base advanced to the merge commit carrying the change.
    const pr = gh.pr(REPO, prNumber);
    expect(pr).toMatchObject({ state: 'closed', merged: true, headSha: h1 });
    expect(pr.mergeCommitSha).toBe(gh.branchHead(REPO, 'dev'));
    expect(gh.files(REPO, 'dev')['src/a.ts']).toBe('export const a = 2;\n');

    // The kernel: MERGED from its own read, once.
    d = (await loadView({ deliveryId: deliveryId! })).delivery!;
    expect(d).toMatchObject({ state: 'MERGED', mergeCommitSha: pr.mergeCommitSha });
    // The closed webhook arrives after the merge: a hint for a fact already recorded.
    await gh.deliverWebhooks();
    expect(ingested).toContain('pull_request.closed');
    const log = (await transitions(deliveryId!)).map((t) => t.command);
    expect(log.filter((c) => c === 'PrMerged')).toHaveLength(1);
    expect(log.slice(-3)).toEqual(['LandingRequested', 'MergeCallResult', 'PrMerged']);
    expect((await loadView({ deliveryId: deliveryId! })).delivery!.state).toBe('MERGED');
    // Every effect the landing owed ran to completion against the fake, the activity comment included.
    const fx = await q<{ kind: string; status: string }>(sql`SELECT kind, status FROM workflow_effects WHERE delivery_id = ${deliveryId}::uuid`);
    expect(fx.filter((e) => e.status !== 'done')).toEqual([]);
    expect(fx.map((e) => e.kind)).toEqual(expect.arrayContaining(['post_review', 'merge_call', 'verify_merge', 'stamp_pr_rows', 'emit_pr_merged', 'render_activity']));
    expect(await gh.api(installationId, `/repos/${REPO}/issues/${prNumber}/comments`)).toHaveLength(1);
    expect((await q<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${ownerTaskId}::uuid`))[0].status).toBe('completed');
    expect(gh.unsupported).toEqual([]);
  });
});

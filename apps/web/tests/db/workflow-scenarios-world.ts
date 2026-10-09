/**
 * The world the named incident scenarios (workflow-scenarios*.test.ts) run in:
 * the real workflow kernel on real Postgres, with every GitHub call going over
 * `fetch` to the stateful fake GitHub (apps/web/src/lib/workflow/testing/fake-github.ts).
 *
 * Import this module FIRST in a scenario file: it installs the same leaf mocks
 * as workflow-fake-github.test.ts (the reviewer prompt, the dispatch wake,
 * team notifications, the scope reconcile, the role list), none of which is
 * GitHub, before anything loads the seam.
 *
 * Each `world()` is its own workspace, installation, repo and fake, so a
 * scenario never sees another one's deliveries, trunk incidents or webhooks.
 * Webhooks are hints (R2): `ingest` maps a delivery to the seam function the
 * webhook route / PR subscribers call for it, and the kernel takes its own read.
 */
import { mock } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const realReviewer = await import('../../src/lib/reviewer');
mock.module('../../src/lib/reviewer', () => ({
  ...realReviewer,
  createReviewerTask: async (p: { workspaceId: string; prNumber: number; workflowRound?: { deliveryId: string; roundId: string; round: number }; headSha: string }) => {
    if (!p.workflowRound) {
      // Legacy's reviewer (the kill-switch hand-off, §14): no delivery, the legacy context keys.
      const taskId = await seedTask(p.workspaceId, { status: 'pending', title: `legacy review #${p.prNumber}` });
      await q(sql`UPDATE tasks SET category = 'review',
        context = jsonb_build_object('prNumber', ${p.prNumber}::int, 'headSha', ${p.headSha}::text) WHERE id = ${taskId}::uuid`);
      return { id: taskId };
    }
    const [d] = await q<{ workspace_id: string }>(sql`SELECT workspace_id FROM workflow_deliveries WHERE id = ${p.workflowRound.deliveryId}::uuid`);
    const taskId = await seedTask(d.workspace_id, { status: 'pending', title: `review r${p.workflowRound.round}` });
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
export type Fake = InstanceType<typeof FakeGithub>;
export type WebhookDelivery = import('../../src/lib/workflow/testing/fake-github').WebhookDelivery;
type Faults = import('../../src/lib/workflow/testing/fake-github').Faults;
export const seam = await import('../../src/lib/workflow/seam');
const { loadView } = await import('../../src/lib/workflow/kernel');

/** CI attempts a red head may spend before it escalates (the policy default). */
export const MAX_CI = 3;

export interface OpenedPr {
  prNumber: number;
  branch: string;
  base: string;
  ownerTaskId: string;
  workerId: string;
  deliveryId: string;
  /** The head the owner pushed. */
  head: string;
}

export interface World {
  workspaceId: string;
  installationId: number;
  repo: string;
  gh: Fake;
  /** Webhooks the ingest mapped, as `<event>.<action>`, in arrival order. */
  ingested: string[];
  /** The owner's worker pushes `branch` (from `from`, default the base) and opens a PR into `base`. */
  openPr(o: { branch: string; base?: string; files: Record<string, string>; title?: string; dependsOn?: string[] }): Promise<OpenedPr>;
  /** The owner attempt ends with its head on GitHub: a review round is dispatched (AWAITING_REVIEW). */
  handOn(pr: OpenedPr): Promise<void>;
  /** The newest reviewer task on the delivery, with the round and head it was filed for. */
  reviewer(pr: OpenedPr): Promise<{ id: string; context: Record<string, unknown> }>;
  /** A reviewer task's verdict on the head it reviewed. */
  verdict(pr: OpenedPr, rv: { id: string; context: Record<string, unknown> }, v: 'approve' | 'request_changes', head: string): ReturnType<typeof seam.recordReviewVerdict>;
  /** handOn + CI green + the reviewer approves the current head: APPROVED. */
  approve(pr: OpenedPr, head?: string): Promise<void>;
  /** A merge door lands the PR at `head`, its rails having passed. */
  land(pr: OpenedPr, head: string): ReturnType<typeof seam.landThroughKernel>;
  delivery(pr: OpenedPr): Promise<NonNullable<Awaited<ReturnType<typeof loadView>>['delivery']>>;
  view(pr: OpenedPr): ReturnType<typeof loadView>;
  /** The delivery's transition log, oldest first. */
  commands(pr: OpenedPr): Promise<string[]>;
  effects(pr: OpenedPr): Promise<Array<{ kind: string; status: string; outcome: string | null; dedupe_key: string }>>;
  taskStatus(taskId: string): Promise<string>;
  /** Tasks the delivery filed in a role (`review`, `fix`, `ci_fix`, `conflict_fix`). */
  tasksOf(pr: OpenedPr, role: string): Promise<Array<{ id: string; status: string; context: Record<string, unknown> }>>;
  /** §11's floor for this one delivery, as the cron runs it (no quiet period). */
  floor(pr: OpenedPr): ReturnType<typeof seam.reconcileKernelDeliveries>;
  /** Every PUT .../merge GitHub answered for this PR, with its status. */
  mergeCalls(pr: OpenedPr): Array<{ method: string; path: string; status: number }>;
  setFaults(f: Faults): void;
  /** Hand one webhook to the ingest directly (a redelivery, or a hand-made order). */
  ingest(d: WebhookDelivery): Promise<void>;
  deliver(): Promise<number>;
  dispose(): void;
}

let worldSeq = 0;

export async function world(o: { seed?: number; files?: Record<string, string>; gitConfig?: Record<string, unknown> } = {}): Promise<World> {
  assertDbConfigured();
  const { workspaceId } = await seedWorkspace();
  if (o.gitConfig) await q(sql`UPDATE workspaces SET git_config = ${JSON.stringify(o.gitConfig)}::jsonb WHERE id = ${workspaceId}::uuid`);
  const installationId = Math.floor(Math.random() * 1e12);
  const run = `${Date.now().toString(36)}${(worldSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const repo = `acme/scenario-${run}`;
  // A cached, unexpired token: getInstallationToken answers from the row and never signs a JWT.
  const [inst] = await q<{ id: string }>(sql`INSERT INTO github_installations (installation_id, account_type, account_login, account_id, access_token, token_expires_at)
    VALUES (${installationId}, 'Organization', 'acme', ${installationId}, 'ghs_fake', now() + interval '1 day') RETURNING id`);
  const [repoRow] = await q<{ id: string }>(sql`INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner, default_branch)
    VALUES (${inst.id}::uuid, ${installationId}, ${repo}, ${repo.split('/')[1]}, 'acme', 'dev') RETURNING id`);
  await q(sql`UPDATE workspaces SET github_installation_id = ${inst.id}::uuid, github_repo_id = ${repoRow.id}::uuid WHERE id = ${workspaceId}::uuid`);

  const gh = new FakeGithub({ installationId, seed: o.seed ?? 7 });
  const restoreFetch = gh.installFetch();
  const ownerByBranch = new Map<string, string>();
  const ingested: string[] = [];

  async function ingest(d: WebhookDelivery): Promise<void> {
    const p = d.payload as Record<string, any>;
    const repoFullName = String(p.repository.full_name);
    const base = { workspaceId, repoFullName, installationId: Number(p.installation.id) };
    ingested.push(`${d.name}.${p.action ?? p.ref}`);
    if (d.name === 'check_suite') {
      // ci-failure-retry.ts's kernel door: a red suite on a PR head is T10 through the seam.
      const suite = p.check_suite as { conclusion: string | null; head_sha: string; pull_requests: Array<{ number: number }> };
      if (p.action !== 'completed' || suite.conclusion !== 'failure') return;
      for (const ref of suite.pull_requests) {
        await seam.observeCiFailure({ ...base, prNumber: ref.number, headSha: suite.head_sha, signature: 'ci_failed', maxAttempts: MAX_CI, source: 'webhook:check_suite' });
      }
      return;
    }
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
  gh.onWebhook(ingest);
  gh.createRepo(repo, { defaultBranch: 'dev', files: o.files ?? { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' } });
  await gh.deliverWebhooks();

  const w: World = {
    workspaceId, installationId, repo, gh, ingested,
    async openPr({ branch, base = 'dev', files, title, dependsOn }) {
      const ownerTaskId = await seedTask(workspaceId, { status: 'in_progress', title: title ?? `feat: ${branch}`, dependsOn });
      ownerByBranch.set(branch, ownerTaskId);
      if (!gh.branchHead(repo, branch)) gh.createBranch(repo, branch, base);
      const head = gh.push(repo, branch, files, { message: title ?? branch });
      const prNumber = gh.openPr(repo, { head: branch, base, title: title ?? `feat: ${branch}` });
      const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
      const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, commit_count)
        VALUES (${workspaceId}::uuid, ${ownerTaskId}::uuid, 'w', 'test', ${branch}, 'running', ${head}, ${prNumber}, ${prUrl}, 1) RETURNING id`);
      await gh.deliverWebhooks();
      const deliveryId = (await seam.kernelDeliveryOfPr({ workspaceId, prNumber }))?.deliveryId;
      if (!deliveryId) throw new Error(`no kernel delivery opened for #${prNumber}`);
      return { prNumber, branch, base, ownerTaskId, workerId: wk.id, deliveryId, head };
    },
    async handOn(pr) {
      await q(sql`UPDATE workers SET status = 'completed' WHERE id = ${pr.workerId}::uuid`);
      const ended = await seam.attemptEnded({
        task: { id: pr.ownerTaskId, workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null },
        workerId: pr.workerId, status: 'completed', localHeadSha: gh.pr(repo, pr.prNumber).headSha, commitCount: 1, source: 'runner',
      });
      if (!ended.handled) throw new Error('owner attempt end not handled');
    },
    async reviewer(pr) {
      const [r] = await q<{ id: string; context: Record<string, unknown> }>(
        sql`SELECT id, context FROM tasks WHERE delivery_id = ${pr.deliveryId}::uuid AND delivery_role = 'review' ORDER BY created_at DESC, id DESC LIMIT 1`);
      if (!r) throw new Error(`no reviewer task on #${pr.prNumber}`);
      return r;
    },
    verdict(pr, rv, v, head) {
      return seam.recordReviewVerdict({
        reviewerTask: { id: rv.id, deliveryId: pr.deliveryId, context: rv.context },
        verdict: v, effectiveVerdict: v, headSha: head, confidence: 0.9,
      });
    },
    async approve(pr, head) {
      const h = head ?? gh.pr(repo, pr.prNumber).headSha;
      if ((await w.delivery(pr)).state === 'WORKING') await w.handOn(pr);
      gh.greenCi(repo, h, ['build', 'test']);
      await gh.deliverWebhooks();
      const r = await w.verdict(pr, await w.reviewer(pr), 'approve', h);
      if (!r.handled || r.toState !== 'APPROVED') throw new Error(`approve did not apply: ${JSON.stringify(r)}`);
      await gh.deliverWebhooks();
    },
    land(pr, head) {
      return seam.landThroughKernel({ workspaceId, installationId, repoFullName: repo, prNumber: pr.prNumber, headSha: head, door: 'auto_merge', actor: 'system:auto_merge' });
    },
    async delivery(pr) {
      const d = (await loadView({ deliveryId: pr.deliveryId })).delivery;
      if (!d) throw new Error('delivery gone');
      return d;
    },
    view: (pr) => loadView({ deliveryId: pr.deliveryId }),
    async commands(pr) {
      return (await q<{ command: string }>(sql`SELECT command FROM workflow_transitions WHERE delivery_id = ${pr.deliveryId}::uuid ORDER BY to_version`)).map((t) => t.command);
    },
    effects: (pr) => q(sql`SELECT kind, status, outcome, dedupe_key FROM workflow_effects WHERE delivery_id = ${pr.deliveryId}::uuid ORDER BY created_at, id`),
    async taskStatus(taskId) {
      return (await q<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${taskId}::uuid`))[0].status;
    },
    tasksOf: (pr, role) => q(sql`SELECT id, status, context FROM tasks WHERE delivery_id = ${pr.deliveryId}::uuid AND delivery_role = ${role} ORDER BY created_at, id`),
    floor: (pr) => seam.reconcileKernelDeliveries({}, { only: [pr.deliveryId], minQuietMs: 0 }),
    mergeCalls: (pr) => gh.calls.filter((c) => c.method === 'PUT' && c.path === `/repos/${repo}/pulls/${pr.prNumber}/merge`),
    setFaults: (f) => gh.setFaults(f),
    ingest: (d) => ingest(structuredClone(d)),
    deliver: () => gh.deliverWebhooks(),
    dispose: () => restoreFetch(),
  };
  return w;
}

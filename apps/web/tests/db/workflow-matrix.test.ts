/**
 * The §16 test matrix of the workflow state kernel (docs/specs/workflow-state-kernel.md
 * §16), S1–S37, as the acceptance for its live path.
 *
 * Every passing case drives the functions the routes and sweeps call (seam.ts)
 * through the real CAS statements on real Postgres, and drains the outbox
 * through the real review-loop effect handlers (review-effects.ts). Only
 * GitHub and the side-effect leaves (posting a review, the PR activity
 * comment, notifications, the dispatch wake, the reviewer prompt) are faked:
 * the decisions under test are the kernel's.
 *
 * Slice A parts 1–2 (PR #3821; the CI ledger, §13.1) are what runs live. A scenario that needs
 * later work is a `test.todo` naming the task that owns it, with the intended
 * assertions beside it; that task turns it into a passing test. The matrix is
 * accepted only when no todo is left.
 *   - 556cd910 (Slice A part 2: CI ledger, provenance by SHA set, BudgetExtended) has no todo
 *     left: S9, S23, S25 and S28 run live; S10, S12 and S15 run the kernel transitions on real
 *     Postgres, with their route wiring a todo of the spec slice that moves those doors.
 *   - 7ab4916f: Slice A part 3 (DeliveryView / owner of next move, activity from
 *     transitions, release composition, S35–S37)
 *   - 2583024f: S30 (runner hand-off failures → AttemptEnded(unproven)) and S31 (preflight,
 *     preflight_miss) run live.
 *   - 6eab5bf4 (Slice C: landing and merge through T15/T16, post-merge work as effects, S20's
 *     stale version) has no todo left: S10, S15 and S20 run their doors' kernel path live.
 *   - eb22d207 (Slice D: supersession T20, abandonment T21, mission completion from the delivery)
 *     has no todo left: S12, S16, S18 and S21 run live.
 *   - 4878423d (Slice B part 2: conflict and migration families, mechanical first) has no
 *     todo left: S25 (conflict), S27 and the refresh_branch half of S15 run live.
 *   - 4878423d (Slice B part 3: the trunk circuit breaker, BLOCKED_ON_TRUNK) has no todo left:
 *     S24 runs live, the base-red rule on by default and `trunkBreaker: false` turning it off.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { LivePr } from '../../src/lib/workflow/commands';
import type { GithubFactReader } from '../../src/lib/workflow/facts';
import type { EffectHandler, EffectHandlers } from '../../src/lib/workflow/effects';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const REPO = 'acme/matrix';
let workspaceId: string;
let teamId: string;
let prSeq = 9100;

// ── Fake GitHub: one PR whose head, state and ancestry a test moves ─────────

interface FakePr {
  head: string; state: 'open' | 'closed'; merged: boolean; updatedAt: string; ancestors: Record<string, string[]>; ciGreen?: boolean | null; failing?: string[] | null; mergeable?: string | null;
  /** The PR's base branch, and whether it still exists (a deleted mission branch closes its PRs, §4 base_deleted). */
  baseRef?: string; baseExists?: boolean | null;
  /** §6.10: failing check names per commit (absent = check runs unreadable), the base branch's head, and commits whose runs are still going. */
  checks?: Record<string, string[]>; baseHead?: string | null; running?: string[];
  /** §8.3: `[from, to]` head pairs whose PR diff the compare API reports unchanged. */
  equivalent?: Array<[string, string]>;
}
let gh: FakePr;
const live = (): LivePr => ({
  state: gh.state, merged: gh.merged, headSha: gh.head, headRepoFullName: REPO, baseRef: gh.baseRef ?? 'dev', updatedAt: gh.updatedAt,
  mergedAt: gh.merged ? '2026-10-06T00:00:00Z' : null, mergeCommitSha: gh.merged ? `M-${gh.head}` : null,
  mergeableState: gh.mergeable ?? null,
});
const reader: GithubFactReader = {
  readPr: async () => live(),
  contains: async (_repo, ancestor, head) => ancestor === head || (gh.ancestors[head] ?? []).includes(ancestor),
  ciGreen: async () => gh.ciGreen ?? null,
  checkRuns: async (_repo, sha) => (gh.checks && sha in gh.checks ? { complete: !(gh.running ?? []).includes(sha), failing: gh.checks[sha] } : null),
  branchHead: async () => gh.baseHead ?? null,
  failingChecks: async () => gh.failing ?? null,
  branchExists: async () => gh.baseExists ?? null,
  contentEquivalent: async (_repo, _base, from, to) => (gh.equivalent ?? []).some(([f, t]) => f === from && t === to),
};
const repoFor = async () => ({ installationId: 1, repoFullName: REPO, gitConfig: null });

// ── Side-effect leaves, recorded ────────────────────────────────────────────

let posted: Array<{ commitId: string; event: string }>;
let postedBodies: string[] = [];
let activity: string[];
let notified: string[];
let exhaustions: number;
let reviewersCreated: Array<{ taskId: string; round: number; head: string }>;
let activityEntries: Array<Record<string, unknown>>;
let ciEscalations: string[];

const realGithubFacts = await import('../../src/lib/workflow/github-facts');
mock.module('../../src/lib/workflow/github-facts', () => ({ ...realGithubFacts, githubReader: () => reader, workspaceRepo: repoFor }));
const realGithub = await import('../../src/lib/github');
/** The PR's issue comments, as GitHub would hold them (render_activity writes here, §12.1). */
let comments: Map<number, string>;
let commentSeq = 1;
/** Composed-PR reads (§5.9 collector: pulls, compare, commits), served per test; undefined = not faked. */
let ghApi: ((path: string) => unknown) | null = null;
/** GitHub writes outside the PR comment (update-branch, git data API), served per test; undefined = accepted. */
let ghWrite: ((path: string, method: string, body: unknown) => unknown) | null = null;
const ghWrites: Array<{ path: string; method: string; body: unknown }> = [];
/** update-branch calls the mechanical refresh made (§6.7), and an error to answer the next one with. */
let updateBranchCalls: Array<{ path: string; expectedHead: string | null }>;
let updateBranchError: string | null;
async function fakeGithubApi(_installationId: number, path: string, opts?: RequestInit): Promise<unknown> {
  const method = opts?.method ?? 'GET';
  if (method === 'PUT' && path.endsWith('/update-branch')) {
    updateBranchCalls.push({ path, expectedHead: JSON.parse(String(opts!.body)).expected_head_sha ?? null });
    if (updateBranchError) { const e = updateBranchError; updateBranchError = null; throw new Error(e); }
    const body = JSON.parse(String(opts!.body));
    ghWrites.push({ path, method, body });
    return (ghWrite ? ghWrite(path, method, body) : undefined) ?? { message: 'Updating pull request branch.' };
  }
  if (ghApi && method === 'GET' && !/\/issues\//.test(path)) { const out = ghApi(path); if (out !== undefined) return out; }
  if (!/\/issues\//.test(path)) {
    if (method === 'GET') return null;
    const body = opts?.body ? JSON.parse(String(opts.body)) : null;
    ghWrites.push({ path, method, body });
    return ghWrite ? ghWrite(path, method, body) ?? {} : {};
  }
  const id = /comments\/(\d+)$/.exec(path);
  if (method === 'GET') return path.includes('page=1') ? [...comments.entries()].map(([cid, body]) => ({ id: cid, body })) : [];
  if (method === 'POST') { const cid = commentSeq++; comments.set(cid, JSON.parse(String(opts!.body)).body); return { id: cid }; }
  if (method === 'PATCH' && id) { comments.set(Number(id[1]), JSON.parse(String(opts!.body)).body); return null; }
  if (method === 'DELETE' && id) { comments.delete(Number(id[1])); return null; }
  return null;
}
/** The pinned merge calls the kernel's merge_call effect made, and how GitHub answers the next one. */
let mergeCalls: Array<{ prNumber: number; method: string; sha: string }>;
let mergeAnswer: () => { merged: boolean; message: string; indeterminate?: boolean };
mock.module('../../src/lib/github', () => ({
  ...realGithub,
  githubApi: fakeGithubApi,
  mergePullRequest: async (_i: number, _repo: string, prNumber: number, method: string, sha: string) => {
    mergeCalls.push({ prNumber, method, sha });
    return mergeAnswer();
  },
  postPrReview: async (p: { headSha: string; event: string; body?: string }) => { posted.push({ commitId: p.headSha, event: p.event }); postedBodies.push(p.body ?? ''); return { posted: true }; },
}));
const realActivity = await import('../../src/lib/pr-activity-comment');
mock.module('../../src/lib/pr-activity-comment', () => ({
  ...realActivity,
  appendPrActivity: async (p: { entry: { kind: string } }) => { activity.push(p.entry.kind); activityEntries.push(p.entry); return { action: 'created' }; },
}));
const realNotify = await import('../../src/lib/notify');
mock.module('../../src/lib/notify', () => ({ ...realNotify, notifyTeamOf: async (_s: unknown, _e: unknown, p: { title: string }) => { notified.push(p.title); } }));
const realDispatch = await import('../../src/lib/dispatch-authority');
mock.module('../../src/lib/dispatch-authority', () => ({ ...realDispatch, announceTaskCreated: async () => {}, wakeTask: async () => {} }));
const realScope = await import('../../src/lib/pr-scope-reconcile-trigger');
mock.module('../../src/lib/pr-scope-reconcile-trigger', () => ({ ...realScope, schedulePrScopeReconcile: () => {} }));
// Supersession reads find the installation for a PR's repo; every repo here is the fake one.
const realInstallation = await import('../../src/lib/workspace-installation');
mock.module('../../src/lib/workspace-installation', () => ({ ...realInstallation, installationIdForRepo: async () => 1 }));
const realReviewRequest = await import('../../src/lib/pr-review-request');
mock.module('../../src/lib/pr-review-request', () => ({ ...realReviewRequest, listWorkspaceRoles: async () => [{ slug: 'reviewer' }] }));
const realAutoMerge = await import('../../src/lib/auto-merge');
mock.module('../../src/lib/auto-merge', () => ({ ...realAutoMerge, escalateReviewerExhaustion: async () => { exhaustions++; } }));
const realReviewer = await import('../../src/lib/reviewer');
mock.module('../../src/lib/reviewer', () => ({
  ...realReviewer,
  // The reviewer prompt is not under test: a pending reviewer task linked to the round, as the real one is.
  createReviewerTask: async (p: { workflowRound: { deliveryId: string; roundId: string; round: number }; headSha: string }) => {
    const taskId = await seedTask(workspaceId, { status: 'pending', title: `review r${p.workflowRound.round}` });
    await q(sql`UPDATE tasks SET delivery_id = ${p.workflowRound.deliveryId}::uuid, delivery_role = 'review', category = 'review',
      context = jsonb_build_object('workflowRoundId', ${p.workflowRound.roundId}::text, 'headSha', ${p.headSha}::text) WHERE id = ${taskId}::uuid`);
    reviewersCreated.push({ taskId, round: p.workflowRound.round, head: p.headSha });
    return { id: taskId };
  },
  supersedeFixTaskOnApproval: async () => ({ superseded: true }),
}));

const realInspect = await import('../../src/lib/ci-failure-inspect');
mock.module('../../src/lib/ci-failure-inspect', () => ({
  ...realInspect,
  fetchCIFailureLogs: async () => ({ summary: 'unit tests failed', runId: 11, runUrl: 'https://ci.example.test/run/11', failedJobId: 12, failedJobNames: ['Unit tests'] }),
}));
const realEvidence = await import('../../src/lib/ci-job-log-evidence');
mock.module('../../src/lib/ci-job-log-evidence', () => ({ ...realEvidence, captureCiJobLogEvidence: async () => ({ kind: 'skipped' }) }));
const realCiRetry = await import('../../src/lib/ci-failure-retry');
mock.module('../../src/lib/ci-failure-retry', () => ({
  ...realCiRetry,
  escalateCiRedHead: async (i: { headSha: string; detail: string }) => { ciEscalations.push(i.detail); return true; },
}));

const seam = await import('../../src/lib/workflow/seam');
const { reviewEffectHandlers: reviewOnly } = await import('../../src/lib/workflow/review-effects');
const { withCiRetryEffects } = await import('../../src/lib/workflow/ci-retry-effects');
const { withTrunkEffects } = await import('../../src/lib/workflow/ci-red-trunk-effects');
const { withConflictEffects } = await import('../../src/lib/workflow/conflict-retry-effects');
const { withPrFactEffects } = await import('../../src/lib/workflow/pr-fact-effects');
const { withLandingEffects } = await import('../../src/lib/workflow/pr-landing-effects');
const { withSupersessionEffects } = await import('../../src/lib/workflow/supersession-effects');
const { recordPrFact } = await import('@buildd/core/pr-facts');
/** The composition root's set (apps/web/src/modules.ts): review loop, the CI family, the conflict/migration families, the trunk breaker, landing, a closed PR's resolution and the fact-cache projection. */
const reviewEffectHandlers = withPrFactEffects(withSupersessionEffects(withLandingEffects(withTrunkEffects(withConflictEffects(withCiRetryEffects(reviewOnly))))));
const { runEffects } = await import('../../src/lib/workflow/effects');
const { applyCommand, loadView } = await import('../../src/lib/workflow/kernel');
const { attemptView, headCoverage } = await import('../../src/lib/workflow/reducer');
const facts = await import('../../src/lib/workflow/facts');
const { kernelDeliveryForPr } = await import('../../src/lib/workflow/authority');
const { getDeliveryViewsForTasks, kernelReplacedFailedTaskIds } = await import('../../src/lib/workflow/delivery-view');
const { buildActionQueue, isActionableChip } = await import('../../src/lib/action-queue');
const { dispatchConflictRetry } = await import('../../src/lib/conflict-retry');
const { recordPrSupersession, recordPrAbandonment } = await import('../../src/lib/pr-supersession');
const { canCompleteMission } = await import('../../src/lib/mission-completion');
const { taskScopeTaskNamesPr } = await import('../../src/lib/task-token-auth');
const { HeaderStatusPill } = await import('../../src/app/app/(protected)/tasks/[id]/TaskSidePanel');
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { getOwnerDeliveryDisplays } = await import('../../src/lib/workflow/delivery-view');
const { deriveStage, deriveStageReading } = await import('../../src/lib/stage');
const { boardStatusForDelivery } = await import('../../src/lib/mission-board');
const { feedStateForDelivery } = await import('../../src/lib/mission-pulse');
const { resolvePrDisplayState } = await import('../../src/lib/pr-presentation');
const { dockToneForDelivery } = await import('../../src/components/chat/dock-model');
const { explainTask } = await import('../../src/lib/explain');

/** The composition root's handlers, with an optional per-test override (a crash, a race). */
let override: Partial<Record<string, EffectHandler>> = {};
const handlers = (): EffectHandlers => new Proxy(reviewEffectHandlers, { get: (t, k: string) => override[k] ?? (t as Record<string, EffectHandler>)[k] }) as EffectHandlers;
async function drain(deliveryId: string) {
  for (let pass = 0; pass < 4; pass++) {
    const s = await runEffects({ deliveryId, handlers: handlers(), limit: 20 });
    if (s.claimed === 0) break;
  }
  return null;
}
const deps = { reader: () => reader, repoFor, drain };
/** A request whose inline drain never ran (the process died after the transition committed). */
const crashedDeps = { ...deps, drain: async () => null };

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId, teamId } = await seedWorkspace());
  // The conflict doors read the workspace's installation (the GitHub surface itself is faked).
  const instNo = Math.floor(Math.random() * 1e12);
  const [inst] = await q<{ id: string }>(sql`INSERT INTO github_installations (installation_id, account_type, account_login, account_id)
    VALUES (${instNo}, 'Organization', 'acme', ${instNo}) RETURNING id`);
  await q(sql`UPDATE workspaces SET github_installation_id = ${inst.id}::uuid WHERE id = ${workspaceId}::uuid`);
});
beforeEach(() => {
  gh = { head: 'H1', state: 'open', merged: false, updatedAt: 'u0', ancestors: {} };
  posted = []; postedBodies = []; activity = []; notified = []; exhaustions = 0; reviewersCreated = []; override = {}; activityEntries = []; ciEscalations = []; ghApi = null; ghWrite = null; ghWrites.length = 0;
  comments = new Map();
  updateBranchCalls = []; updateBranchError = null; mergeCalls = [];
  // GitHub merges a PR whose head is the pinned one, as the real PUT /merge does.
  mergeAnswer = () => { gh.state = 'closed'; gh.merged = true; gh.updatedAt = 'u-merged'; return { merged: true, message: 'Pull Request successfully merged' }; };
});

// ── Fixtures and reads ──────────────────────────────────────────────────────

async function seedWorker(taskId: string, o: { status: string; lastCommitSha?: string | null; prNumber?: number; commitCount?: number }) {
  const [w] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, commit_count)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w', 'test', 'feat/matrix', ${o.status}, ${o.lastCommitSha ?? null}, ${o.prNumber ?? null}, ${o.commitCount ?? 0}) RETURNING id`);
  return w.id;
}

type Delivery = { ownerTaskId: string; prNumber: number; deliveryId: string };

/** A PR opened after cutover; the owner worker is the PR's worker row. */
async function open(): Promise<Delivery> {
  const ownerTaskId = await seedTask(workspaceId, { status: 'in_progress', title: 'feat: matrix owner' });
  const prNumber = prSeq++;
  await seedWorker(ownerTaskId, { status: 'running', lastCommitSha: 'H1', prNumber });
  const opened = await seam.openKernelDelivery({ workspaceId, ownerTaskId, repoFullName: REPO, prNumber, installationId: 1, source: 'webhook:opened' }, deps);
  expect(opened.owned).toBe(true);
  return { ownerTaskId, prNumber, deliveryId: opened.deliveryId! };
}

/** …and its owner attempt ended with the head on GitHub: AWAITING_REVIEW, round 1 dispatched. */
async function openAndHandOn(): Promise<Delivery> {
  const o = await open();
  const workerId = await seedWorker(o.ownerTaskId, { status: 'completed', lastCommitSha: 'H1', prNumber: o.prNumber, commitCount: 1 });
  const ended = await seam.attemptEnded({ task: ownerTask(o), workerId, status: 'completed', localHeadSha: 'H1', commitCount: 1, source: 'runner' }, deps);
  expect(ended.handled).toBe(true);
  return o;
}

const ownerTask = (o: Delivery) => ({ id: o.ownerTaskId, workspaceId, deliveryId: o.deliveryId, deliveryRole: 'owner', context: null });

async function taskRow(id: string) {
  const [t] = await q<{ id: string; delivery_id: string; delivery_role: string; context: Record<string, unknown>; status: string; title: string; result: Record<string, unknown> | null }>(
    sql`SELECT id, delivery_id, delivery_role, context, status, title, result FROM tasks WHERE id = ${id}::uuid`);
  return { ...t, task: { id: t.id, workspaceId, deliveryId: t.delivery_id, deliveryRole: t.delivery_role, context: t.context } };
}
const tasksOf = (deliveryId: string, role: 'fix' | 'review' | 'ci_fix') => q<{ id: string; status: string; title: string; context: Record<string, unknown>; creation_source: string; result: Record<string, unknown> | null }>(
  sql`SELECT id, status, title, context, creation_source, result FROM tasks WHERE delivery_id = ${deliveryId}::uuid AND delivery_role = ${role} ORDER BY created_at, id`);
const rounds = (deliveryId: string) => q<{ id: string; round: number; head_sha: string; status: string; kind: string; verdict: string | null; failure_count: number }>(
  sql`SELECT id, round, head_sha, status, kind, verdict, failure_count FROM workflow_review_rounds WHERE delivery_id = ${deliveryId}::uuid ORDER BY round`);
const transitions = (deliveryId: string) => q<{ id: string; command: string; to_state: string; evidence: Record<string, unknown>; to_version: number }>(
  sql`SELECT id, command, to_state, evidence, to_version FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid ORDER BY to_version`);
const effects = (deliveryId: string, kind?: string) => q<{ id: string; kind: string; status: string; outcome: string | null; dedupe_key: string; attempt_count: number; transition_id: string; last_error: string | null }>(
  sql`SELECT id, kind, status, outcome, dedupe_key, attempt_count, transition_id, last_error FROM workflow_effects
      WHERE delivery_id = ${deliveryId}::uuid ${kind ? sql`AND kind = ${kind}` : sql``} ORDER BY created_at, id`);
const delivery = async (deliveryId: string) => (await loadView({ deliveryId })).delivery!;
/** Bring every pending effect of the delivery due now (the backoff / push_recovery delay elapsed). */
const makeDue = (deliveryId: string) => q(sql`UPDATE workflow_effects SET not_before = now() - interval '1 second' WHERE delivery_id = ${deliveryId}::uuid AND status = 'pending'`);

/** The newest reviewer task of the delivery (the current round's). */
const reviewerOf = async (deliveryId: string) => (await taskRow((await tasksOf(deliveryId, 'review')).at(-1)!.id)).task;
async function verdict(o: Delivery, v: 'approve' | 'request-changes' | 'escalate', head = gh.head, d = deps) {
  return seam.recordReviewVerdict({ reviewerTask: await reviewerOf(o.deliveryId), verdict: v, effectiveVerdict: v, headSha: head, confidence: 0.9 }, d);
}
/** A push; `equivalent: true` = the compare API reports the PR diff unchanged from the head it replaces (§8.3). */
const push = (o: Delivery, head: string, extra: { equivalent?: boolean; ancestors?: string[] } = {}) => {
  if (extra.equivalent) (gh.equivalent ??= []).push([gh.head, head]);
  gh.head = head;
  if (extra.ancestors) gh.ancestors[head] = extra.ancestors;
  return seam.observeHead({
    workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, hintedHeadSha: head, source: 'webhook:synchronize',
  }, deps);
};
const closeOrMerge = (o: Delivery, merged: boolean, updatedAt = 'u1') => {
  gh.state = 'closed'; gh.merged = merged; gh.updatedAt = updatedAt;
  return seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'webhook:closed' }, deps);
};

// ── A closed PR's resolution (Slice D) ──────────────────────────────────────

const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;
/** Every worker row of the PR carries its URL, as create_pr and the webhook record it. */
const stampPrUrl = (o: Delivery) => q(sql`UPDATE workers SET pr_url = ${prUrl(o.prNumber)} WHERE workspace_id = ${workspaceId}::uuid AND pr_number = ${o.prNumber}`);
const prWorkerOf = async (o: Delivery) => (await q<{ id: string }>(sql`SELECT id FROM workers WHERE workspace_id = ${workspaceId}::uuid AND pr_number = ${o.prNumber} ORDER BY created_at DESC LIMIT 1`))[0].id;
const prRows = (o: Delivery) => q<{ superseded_by_pr_number: number | null; superseded_recorded_by: string | null; abandoned_reason: string | null; abandoned_recorded_by: string | null; merged_at: string | null }>(
  sql`SELECT superseded_by_pr_number, superseded_recorded_by, abandoned_reason, abandoned_recorded_by, merged_at FROM workers WHERE workspace_id = ${workspaceId}::uuid AND pr_number = ${o.prNumber}`);
/**
 * The owner task, completed, as the one deliverable of a fresh active mission. Held, so the
 * resolution's wake_mission (which would re-plan and close it) leaves it for the test to judge.
 */
async function inMission(o: Delivery): Promise<string> {
  const [m] = await q<{ id: string }>(sql`INSERT INTO missions (team_id, workspace_id, title, is_held) VALUES (${teamId}::uuid, ${workspaceId}::uuid, 'matrix mission', true) RETURNING id`);
  await q(sql`UPDATE tasks SET mission_id = ${m.id}::uuid, status = 'completed' WHERE id = ${o.ownerTaskId}::uuid`);
  return m.id;
}
/** GitHub's answer for a merged PR the supersession write verifies (live read, write time). */
const mergedPr = (n: number) => ({ number: n, merged: true, state: 'closed', html_url: prUrl(n), merge_commit_sha: `M${n}`, commits: 1 });

/** request-changes on round 1, the fix task filed by the real dispatch_fix, claimed: FIXING at H1. */
async function fixing(o?: Delivery) {
  o ??= await openAndHandOn();
  expect(await verdict(o, 'request-changes')).toMatchObject({ handled: true, toState: 'CHANGES_REQUESTED' });
  const [fix] = await tasksOf(o.deliveryId, 'fix');
  const t = (await taskRow(fix.id)).task;
  expect(await seam.claimFix(t, deps)).toEqual({ action: 'proceed' });
  expect((await delivery(o.deliveryId)).state).toBe('FIXING');
  return { ...o, fix: t };
}

/** S1's dead end: the fix committed L2 locally, GitHub still has H1, the attempt ended. */
async function awaitingPush() {
  const f = await fixing();
  const workerId = await seedWorker(f.fix.id, { status: 'completed', lastCommitSha: 'L2', commitCount: 1 });
  const ended = await seam.attemptEnded({ task: f.fix, workerId, status: 'completed', localHeadSha: 'L2', commitCount: 1, source: 'runner' }, deps);
  expect((await delivery(f.deliveryId)).state).toBe('AWAITING_PUSH');
  return { ...f, workerId, ended };
}

// ── The CI family (Slice A part 2) ──────────────────────────────────────────

/** The check_suite webhook / red-PR sweep door for a kernel-owned PR (T10). */
const ciFail = (o: Delivery, opts: { head?: string; max?: number; d?: typeof deps } = {}) => seam.observeCiFailure({
  workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, headSha: opts.head ?? gh.head,
  signature: 'ci_failed', maxAttempts: opts.max ?? 3, source: 'webhook:check_suite',
}, opts.d ?? deps);
const ciAttempts = async (deliveryId: string) => (await loadView({ deliveryId })).attempts.filter((a) => a.family === 'ci');

/** A CI fix worker ended: the terminal PATCH settles the task row, then T4 runs. */
async function endCi(t: { id: string } & Record<string, unknown>, status: 'completed' | 'failed' | 'lost', o: { local?: string | null; commits?: number } = {}) {
  await q(sql`UPDATE tasks SET status = ${status === 'completed' ? 'completed' : 'failed'} WHERE id = ${t.id}::uuid`);
  const w = await seedWorker(t.id, { status: status === 'completed' ? 'completed' : 'failed', lastCommitSha: o.local ?? null, commitCount: o.commits ?? 0 });
  return seam.attemptEnded({ task: t as never, workerId: w, status, localHeadSha: o.local ?? null, commitCount: o.commits ?? 0, source: status === 'lost' ? 'sweep:stale-workers' : 'runner' }, deps);
}

/** CI red on the current head; the CI fix task filed by the real dispatch_ci_fix and claimed. */
async function ciRepairing(o: Delivery, max = 3) {
  const seen = await ciFail(o, { max });
  expect(seen).toMatchObject({ handled: true, result: { result: 'applied' } });
  const t = (await taskRow((seen as { attemptTaskId: string }).attemptTaskId)).task;
  expect(await seam.claimFix(t, deps)).toEqual({ action: 'proceed' });
  return t;
}


// ── The conflict and migration families (Slice B part 2) ────────────────────

const conflictTasks = (deliveryId: string) => tasksOf(deliveryId, 'conflict_fix' as never);
/** Mechanical rows before agent rows, each by attempt number: the order the kernel allocates them. */
const repairAttempts = async (deliveryId: string) => (await loadView({ deliveryId })).attempts
  .filter((a) => a.family === 'conflict' || a.family === 'migration')
  .sort((x, y) => (x.mode === y.mode ? x.attemptNo - y.attemptNo : x.mode === 'mechanical' ? -1 : 1));
/** The owner task's own PR worker (the one the conflict doors are called with). */
const ownerPrWorkerOf = async (o: Delivery) => (await q<{ id: string }>(sql`SELECT id FROM workers WHERE task_id = ${o.ownerTaskId}::uuid AND pr_number = ${o.prNumber}::int ORDER BY created_at LIMIT 1`))[0].id;
/**
 * Every door that used to decide a conflict retry funnels through dispatchConflictRetry. The PR's
 * worker rows carry its URL, as create_pr records it: the handlers find the PR worker by repo.
 */
const conflictDoor = async (o: Delivery, extra: Partial<Parameters<typeof dispatchConflictRetry>[0]> = {}) =>
  (await stampPrUrl(o), dispatchConflictRetry({ workerId: await ownerPrWorkerOf(o), taskId: o.ownerTaskId, prNumber: o.prNumber, headSha: gh.head, repoFullName: REPO, workspaceId, ...extra }));
/** GitHub's update-branch: either merges the base in (a new head descending from the old) or refuses. */
function updateBranch(outcome: { merged: string } | { conflict: true; thenMergeable?: string }) {
  ghWrite = (path, method) => {
    if (!/\/update-branch$/.test(path) || method !== 'PUT') return undefined;
    if ('merged' in outcome) {
      gh.ancestors[outcome.merged] = [gh.head];
      gh.head = outcome.merged; gh.mergeable = 'clean';
      return { message: 'Updating pull request branch.' };
    }
    if (outcome.thenMergeable) gh.mergeable = outcome.thenMergeable;
    throw new Error('GitHub API error: 422 {"message":"merge conflict between base and head"}');
  };
}
const b64 = (t: string) => ({ encoding: 'base64', content: Buffer.from(t).toString('base64') });
/**
 * A PR adding `packages/core/drizzle/0007_add.sql` while open PR #77 into `peerBase` adds another
 * 0007. `journal`: the directory carries drizzle's meta/ (a chained journal, not renumberable).
 */
function migrationRepo(o: Delivery, opts: { journal: boolean; peerBase?: string; ourBase?: string }) {
  const dir = 'packages/core/drizzle';
  const ourBase = opts.ourBase ?? 'dev';
  ghApi = (path) => {
    if (path.startsWith(`/repos/${REPO}/pulls/${o.prNumber}/files`)) return [{ filename: `${dir}/0007_add.sql`, status: 'added' }];
    if (path.startsWith(`/repos/${REPO}/pulls/77/files`)) return [{ filename: `${dir}/0007_other.sql`, status: 'added' }];
    if (path.startsWith(`/repos/${REPO}/pulls?state=open`)) {
      return [{ number: o.prNumber, base: { ref: ourBase }, head: { sha: gh.head } }, { number: 77, base: { ref: opts.peerBase ?? ourBase }, head: { sha: 'O1' } }];
    }
    if (path === `/repos/${REPO}/pulls/${o.prNumber}`) return { head: { ref: 'feat/matrix', sha: gh.head }, base: { ref: ourBase, repo: { default_branch: 'dev' } } };
    if (path === `/repos/${REPO}/pulls/77`) return { head: { sha: 'O1' } };
    const file = /\/contents\/(.+)\?ref=(.+)$/.exec(path);
    if (file) {
      const [p2, ref] = [decodeURIComponent(file[1]), decodeURIComponent(file[2])];
      if (p2 === `${dir}/0007_add.sql`) return ref === gh.head ? b64('CREATE TABLE "a" ();') : null;
      if (p2 === `${dir}/0007_other.sql`) return ref === 'O1' ? b64('CREATE TABLE "b" ();') : null;
      if (p2 === dir) {
        const base = [{ name: '0005_x.sql', path: `${dir}/0005_x.sql`, sha: 's5', type: 'file' }, { name: '0006_y.sql', path: `${dir}/0006_y.sql`, sha: 's6', type: 'file' }];
        if (ref === gh.head) return [...base, { name: '0007_add.sql', path: `${dir}/0007_add.sql`, sha: 'BLOB7', type: 'file' }, ...(opts.journal ? [{ name: 'meta', path: `${dir}/meta`, sha: 'm', type: 'dir' }] : [])];
        if (ref === 'O1') return [...base, { name: '0007_other.sql', path: `${dir}/0007_other.sql`, sha: 'o7', type: 'file' }];
        return base;
      }
      return null;
    }
    if (/\/git\/commits\/[^/]+$/.test(path)) return { tree: { sha: 'TREE0' } };
    return undefined;
  };
  ghWrite = (path, method) => {
    if (path.endsWith('/git/trees') && method === 'POST') return { sha: 'TREE1' };
    if (path.endsWith('/git/commits') && method === 'POST') return { sha: 'N1' };
    if (/\/git\/refs\/heads\//.test(path) && method === 'PATCH') { gh.ancestors.N1 = [gh.head]; gh.head = 'N1'; return {}; }
    return undefined;
  };
  return { file: '0007_add.sql', otherFile: '0007_other.sql', otherPrNumber: 77 };
}

// ══ S1–S8: the review / fix / approval loop ══════════════════════════════════

describe('S1 — fix ends with a local commit, GitHub head unchanged (#3754)', () => {
  test('gate refuses delivery_not_advanced; the ended attempt is AWAITING_PUSH + one push_recovery; no round 2; replay is a duplicate', async () => {
    const f = await fixing();
    const refusal = await seam.fixCompletionGate({ task: f.fix, localHeadSha: 'L2' }, deps);
    expect(refusal).toMatchObject({ code: 'delivery_not_advanced', boundHeadSha: 'H1', liveHeadSha: 'H1', localHeadSha: 'L2' });

    const workerId = await seedWorker(f.fix.id, { status: 'completed', lastCommitSha: 'L2', commitCount: 1 });
    const end = () => seam.attemptEnded({ task: f.fix, workerId, status: 'completed', localHeadSha: 'L2', commitCount: 1, source: 'runner' }, deps);
    expect((await end()).result).toMatchObject({ result: 'applied' });
    expect((await end()).result).toMatchObject({ result: 'duplicate' });

    const view = await loadView({ deliveryId: f.deliveryId });
    expect(view.delivery).toMatchObject({ state: 'AWAITING_PUSH', currentHeadSha: 'H1', currentRound: 1 });
    expect(view.attempts.find((a) => a.family === 'review_fix')).toMatchObject({ status: 'ended', outcome: 'unproven', reportedShas: ['L2'] });
    expect((await effects(f.deliveryId, 'push_recovery')).map((e) => e.dedupe_key)).toEqual([`push_recovery:${f.deliveryId}:L2:1`]);

    // "Re-reviewing after fix 1" against H1 is unreachable, from every door.
    const again = await seam.requestReview({ workspaceId, repoFullName: REPO, prNumber: f.prNumber, installationId: 1, forced: false, actor: 'kernel' }, deps);
    expect(again).toMatchObject({ handled: true, result: { result: 'rejected', reason: 'state_not_allowed' } });
    expect((await rounds(f.deliveryId)).length).toBe(1);
    expect(reviewersCreated.length).toBe(1);
    // No fix_ended-then-review: the only review_queued entry is round 1's.
    expect(activity.filter((k) => k === 'review_queued').length).toBe(1);
  });

  test('push_recovery re-reads GitHub on a bounded schedule, then a person is told (T22 push_undeliverable)', async () => {
    const p = await awaitingPush();
    for (const expected of ['ok:retry_2', 'ok:retry_3']) {
      await makeDue(p.deliveryId);
      await drain(p.deliveryId);
      expect((await effects(p.deliveryId, 'push_recovery')).some((e) => e.outcome === expected)).toBe(true);
      expect((await delivery(p.deliveryId)).state).toBe('AWAITING_PUSH');
    }
    await makeDue(p.deliveryId);
    await drain(p.deliveryId);
    const d = await delivery(p.deliveryId);
    expect(d).toMatchObject({ state: 'ESCALATED', stateReason: 'push_undeliverable' });
    expect((await effects(p.deliveryId, 'push_recovery')).map((e) => e.outcome)).toEqual(['ok:retry_2', 'ok:retry_3', 'ok:exhausted']);
    expect(notified.some((t) => t.includes('never reached GitHub'))).toBe(true);
    expect((await rounds(p.deliveryId)).length).toBe(1);
  });

  test('a push that lands later (no webhook) is found by push_recovery and hands back to review: delta round 2 at the pushed head', async () => {
    const p = await awaitingPush();
    gh.head = 'L2'; gh.ancestors.L2 = ['H1'];
    await makeDue(p.deliveryId);
    await drain(p.deliveryId);
    expect(await delivery(p.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'L2', currentRound: 2 });
    expect((await rounds(p.deliveryId)).map((r) => [r.round, r.head_sha, r.kind])).toEqual([[1, 'H1', 'full'], [2, 'L2', 'delta']]);
    expect(reviewersCreated.map((r) => [r.round, r.head])).toEqual([[1, 'H1'], [2, 'L2']]);
  });

  test('a head that does not contain the local work is not proof: recorded, still AWAITING_PUSH', async () => {
    const p = await awaitingPush();
    await push(p, 'X3', { ancestors: ['H1'] });
    expect(await delivery(p.deliveryId)).toMatchObject({ state: 'AWAITING_PUSH', currentHeadSha: 'X3', currentRound: 1 });
    expect(reviewersCreated.length).toBe(1);
  });
});

describe('S2 — approve at H0, non-equivalent push to H1', () => {
  test('APPROVED → AWAITING_REVIEW with a delta round dispatched on the push, never at merge time; the old approval covers only its own head', async () => {
    const o = await openAndHandOn();
    expect(await verdict(o, 'approve')).toMatchObject({ handled: true, toState: 'APPROVED' });
    expect(posted).toEqual([{ commitId: 'H1', event: 'APPROVE' }]);
    await push(o, 'H2');
    const d = await delivery(o.deliveryId);
    expect(d).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H2', currentRound: 2, approvedHeads: ['H1'] });
    expect((await rounds(o.deliveryId)).map((r) => [r.round, r.kind, r.status])).toEqual([[1, 'full', 'decided'], [2, 'delta', 'queued']]);
    expect(reviewersCreated.map((r) => r.head)).toEqual(['H1', 'H2']);
  });
});

describe('S3 — approve at H0, head moves by a content-equivalent change', () => {
  test('approved_heads appended once even when the push is observed twice concurrently', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    gh.head = 'H2';
    gh.equivalent = [['H1', 'H2']];
    const obs = () => seam.observeHead({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, hintedHeadSha: 'H2', source: 'webhook:synchronize' }, deps);
    await Promise.all([obs(), obs(), obs()]);
    const d = await delivery(o.deliveryId);
    expect(d).toMatchObject({ state: 'APPROVED', currentHeadSha: 'H2', approvedHeads: ['H1', 'H2'] });
    expect((await transitions(o.deliveryId)).filter((t) => t.command === 'HeadObserved' && t.to_state === 'APPROVED').length).toBe(1);
    expect(reviewersCreated.length).toBe(1);
  });

  test('the platform\'s own refresh carries forward; a later non-equivalent push is still re-reviewed', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    await push(o, 'H2', { equivalent: true });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'APPROVED', approvedHeads: ['H1', 'H2'] });
    await push(o, 'H3');
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H3', currentRound: 2, approvedHeads: ['H1', 'H2'] });
  });
});

describe('T13 — carry-forward decides from the delivery (task 1ebce52a)', () => {
  test('a newer legacy reviewer row at another head saying request-changes does not stop the carry', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    // A reviewer row newer than round 1's, at a head this delivery never reviewed: the old
    // carry-forward read "the newest reviewer row" and refused on it.
    const legacy = await seedTask(workspaceId, { status: 'completed', title: 'legacy review' });
    await q(sql`UPDATE tasks SET category = 'review',
      context = jsonb_build_object('prNumber', ${o.prNumber}::int, 'headSha', 'HX'),
      result = jsonb_build_object('structuredOutput', jsonb_build_object('verdict', 'request-changes', 'confidence', 0.9))
      WHERE id = ${legacy}::uuid`);
    await push(o, 'H2', { equivalent: true });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'APPROVED', currentHeadSha: 'H2', approvedHeads: ['H1', 'H2'] });
    expect(reviewersCreated.length).toBe(1);
  });

  test('equivalentHeadShas is a projection of an applied T13 onto the approving round\'s reviewer, never ahead of it', async () => {
    const o = await openAndHandOn();
    const [r1] = await tasksOf(o.deliveryId, 'review');
    await verdict(o, 'approve');
    await push(o, 'H2', { equivalent: true });
    expect((await taskRow(r1.id)).context.equivalentHeadShas).toEqual(['H2']);
    // Not equivalent: a delta round, and nothing is projected for H3.
    await push(o, 'H3');
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H3', currentRound: 2 });
    expect((await taskRow(r1.id)).context.equivalentHeadShas).toEqual(['H2']);
    const carried = (await transitions(o.deliveryId)).filter((t) => t.command === 'HeadObserved' && t.to_state === 'APPROVED');
    expect(carried.map((t) => t.evidence.carryForward)).toEqual(['content_equivalent']);
  });

  test('a head moved by the platform\'s own refresh_branch, pinned to the approved head, is carried as own_refresh', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    const last = (await transitions(o.deliveryId)).at(-1)!;
    await q(sql`INSERT INTO workflow_effects (delivery_id, transition_id, kind, dedupe_key, payload, status, outcome)
      VALUES (${o.deliveryId}::uuid, ${last.id}::uuid, 'refresh_branch', ${`refresh_branch:${o.deliveryId}:H1:test`},
        jsonb_build_object('headSha', 'H1', 'reason', 'trunk_recovered'), 'done', 'ok:updated')`);
    await push(o, 'R1', { ancestors: ['H1'], equivalent: true });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'APPROVED', currentHeadSha: 'R1', approvedHeads: ['H1', 'R1'] });
    expect((await transitions(o.deliveryId)).at(-1)!.evidence).toMatchObject({ carryForward: 'own_refresh' });
  });

  test('without content equivalence nothing carries, even after the platform\'s own refresh', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    const last = (await transitions(o.deliveryId)).at(-1)!;
    await q(sql`INSERT INTO workflow_effects (delivery_id, transition_id, kind, dedupe_key, payload, status, outcome)
      VALUES (${o.deliveryId}::uuid, ${last.id}::uuid, 'refresh_branch', ${`refresh_branch:${o.deliveryId}:H1:test`},
        jsonb_build_object('headSha', 'H1', 'reason', 'trunk_recovered'), 'done', 'ok:updated')`);
    await push(o, 'R1', { ancestors: ['H1'] });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'R1', currentRound: 2, approvedHeads: ['H1'] });
  });
});

describe('S4 — late verdict for a superseded head', () => {
  test('an approve is stored on its own round; no state change, no post_review, no approval', async () => {
    const o = await openAndHandOn();
    const r1 = await reviewerOf(o.deliveryId);
    await push(o, 'H2');
    const late = await seam.recordReviewVerdict({ reviewerTask: r1, verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 0.99 }, deps);
    expect(late).toMatchObject({ handled: true, toState: null, result: { result: 'stale' } });
    expect(posted).toEqual([]);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2, approvedHeads: [] });
    expect((await rounds(o.deliveryId))[0]).toMatchObject({ round: 1, status: 'superseded', verdict: 'approve' });
  });

  test('a late request-changes files no fix', async () => {
    const o = await openAndHandOn();
    const r1 = await reviewerOf(o.deliveryId);
    await push(o, 'H2');
    await seam.recordReviewVerdict({ reviewerTask: r1, verdict: 'request-changes', effectiveVerdict: 'request-changes', headSha: 'H1', confidence: 0.9 }, deps);
    expect((await delivery(o.deliveryId)).state).toBe('AWAITING_REVIEW');
    expect(await tasksOf(o.deliveryId, 'fix')).toEqual([]);
    expect(posted).toEqual([]);
  });
});

describe('S5 — duplicate webhook delivery and duplicate reviewer PATCH', () => {
  test('a redelivered synchronize is one fact and one transition', async () => {
    const o = await openAndHandOn();
    await push(o, 'H2');
    const before = (await transitions(o.deliveryId)).length;
    await push(o, 'H2');
    await push(o, 'H2');
    expect((await transitions(o.deliveryId)).length).toBe(before);
    // One fact for the move; a redelivery is answered with it (§5.3), not recorded again.
    const facts = await q(sql`SELECT 1 FROM workflow_facts WHERE workspace_id = ${workspaceId}::uuid AND fact_key LIKE ${`head:${REPO}#${o.prNumber}:%->H2@v%`}`);
    expect(facts.length).toBe(1);
    expect(reviewersCreated.length).toBe(2);
  });

  test('a head that returns to an earlier SHA (A→B→A) is applied, not dropped as a duplicate (34b69829)', async () => {
    const o = await openAndHandOn();
    const before = (await transitions(o.deliveryId)).filter((t) => t.command === 'HeadObserved').length;
    const heads = async () => (await transitions(o.deliveryId)).filter((t) => t.command === 'HeadObserved').length - before;
    await push(o, 'H2');
    expect(await heads()).toBe(1);
    await push(o, 'H1');
    expect(await heads()).toBe(2);
    expect(await delivery(o.deliveryId)).toMatchObject({ currentHeadSha: 'H1' });
    // …and once more round the cycle: the repeated H1→H2 move is new too.
    await push(o, 'H2');
    expect(await heads()).toBe(3);
    expect(await delivery(o.deliveryId)).toMatchObject({ currentHeadSha: 'H2' });
    // A redelivery of that last move is still one transition.
    await push(o, 'H2');
    expect(await heads()).toBe(3);
  });

  test('a replayed reviewer PATCH is a duplicate, sequential or concurrent; effects are not doubled', async () => {
    const o = await openAndHandOn();
    const results = await Promise.all([verdict(o, 'request-changes'), verdict(o, 'request-changes')]);
    expect(results.map((r) => (r as { result: { result: string } }).result.result).sort()).toEqual(['applied', 'duplicate']);
    expect((await verdict(o, 'request-changes'))).toMatchObject({ result: { result: 'duplicate' } });
    expect((await tasksOf(o.deliveryId, 'fix')).length).toBe(1);
    expect(posted.length).toBe(1);
    expect((await effects(o.deliveryId, 'dispatch_fix')).length).toBe(1);
  });

  test('a replayed owner AttemptEnded queues no second round', async () => {
    const o = await open();
    const workerId = await seedWorker(o.ownerTaskId, { status: 'completed', lastCommitSha: 'H1', prNumber: o.prNumber, commitCount: 1 });
    const end = () => seam.attemptEnded({ task: ownerTask(o), workerId, status: 'completed', localHeadSha: 'H1', commitCount: 1, source: 'runner' }, deps);
    await Promise.all([end(), end()]);
    await end();
    expect((await rounds(o.deliveryId)).length).toBe(1);
    expect(reviewersCreated.length).toBe(1);
  });
});

describe('S6 — out of order: closed(merged), then late synchronize / opened / verdict', () => {
  test('terminal wins: MERGED never moves, and a replayed close is a duplicate', async () => {
    const o = await openAndHandOn();
    const r1 = await reviewerOf(o.deliveryId);
    await closeOrMerge(o, true);
    const merged = await delivery(o.deliveryId);
    expect(merged).toMatchObject({ state: 'MERGED', mergeCommitSha: 'M-H1' });
    const n = (await transitions(o.deliveryId)).length;

    gh.state = 'open'; gh.merged = false;
    await push(o, 'H5');
    expect(await seam.openKernelDelivery({ workspaceId, ownerTaskId: o.ownerTaskId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'webhook:opened' }, deps))
      .toEqual({ owned: true, deliveryId: o.deliveryId });
    expect(await seam.recordReviewVerdict({ reviewerTask: r1, verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 1 }, deps))
      .toMatchObject({ handled: true, toState: null });
    gh.state = 'closed'; gh.merged = true; gh.head = 'H1';
    await closeOrMerge(o, true);

    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'MERGED', currentHeadSha: 'H1', version: merged.version });
    expect((await transitions(o.deliveryId)).length).toBe(n);
  });

  /** The worker rows of a delivery's PR as the fact cache holds them. */
  const prRows = (o: Delivery) => q<{ id: string; pr_lifecycle_status: string | null; merged_at: string | null }>(
    sql`SELECT id, pr_lifecycle_status, merged_at FROM workers WHERE pr_number = ${o.prNumber}::int AND workspace_id = ${workspaceId}::uuid ORDER BY created_at, id`);
  const prUrl = (o: Delivery) => `https://github.com/${REPO}/pull/${o.prNumber}`;

  test('S6: the merge reaches every worker row through stamp_pr_rows; late open-state and CI facts leave them as the merge set them', async () => {
    const o = await openAndHandOn();
    await q(sql`UPDATE workers SET pr_url = ${prUrl(o)}, pr_lifecycle_status = 'ci_green' WHERE pr_number = ${o.prNumber}::int AND workspace_id = ${workspaceId}::uuid`);
    await closeOrMerge(o, true);
    expect((await effects(o.deliveryId, 'stamp_pr_rows')).map((e) => [e.status, e.outcome])).toEqual([['done', 'ok:merged_2']]);
    const merged = await prRows(o);
    expect(merged.length).toBe(2);
    for (const r of merged) {
      expect(r.pr_lifecycle_status).toBe('merged');
      // GitHub's merged_at from the kernel's live read, not receipt time.
      expect(new Date(r.merged_at!).toISOString()).toBe('2026-10-06T00:00:00.000Z');
    }

    // The late deliveries the webhook and the sweeps would hand the funnel, in a hostile order.
    const target = { prUrl: prUrl(o), prNumber: o.prNumber };
    expect(await recordPrFact(target, { kind: 'open' })).toEqual([]); // late synchronize / opened
    expect(await recordPrFact(target, { kind: 'open', reopened: true })).toEqual([]);
    expect(await recordPrFact(target, { kind: 'ci', status: 'ci_failed', headSha: 'H1', currentHeadSha: 'H1' })).toEqual([]); // late check_suite
    expect(await recordPrFact(target, { kind: 'closed' })).toEqual([]);
    expect(await recordPrFact(target, { kind: 'merged', mergedAt: new Date() })).toEqual([]); // a merge door's receipt time
    // …and the kernel's own late CI fact files nothing on a merged delivery.
    expect(await ciFail(o, { head: 'H1' })).toMatchObject({ handled: true, result: { result: 'stale' } });
    expect(await tasksOf(o.deliveryId, 'ci_fix')).toEqual([]);
    expect(await prRows(o)).toEqual(merged);
  });

  test('S6: a check_suite failure for the pre-push SHA neither overwrites CI on the delivery nor the fact cache, and files no CI fix', async () => {
    const o = await openAndHandOn();
    await q(sql`UPDATE workers SET pr_url = ${prUrl(o)} WHERE pr_number = ${o.prNumber}::int AND workspace_id = ${workspaceId}::uuid`);
    await push(o, 'H2', { ancestors: ['H1'] });
    await recordPrFact({ prUrl: prUrl(o), prNumber: o.prNumber }, { kind: 'ci', status: 'ci_green', headSha: 'H2', currentHeadSha: 'H2' });
    const before = await delivery(o.deliveryId);
    // The old suite's failure arrives late: its SHA is H1, the PR head is H2.
    expect(await ciFail(o, { head: 'H1' })).toMatchObject({ handled: true, result: { result: 'stale', reason: 'head_not_current' } });
    expect(await recordPrFact({ prUrl: prUrl(o), prNumber: o.prNumber }, { kind: 'ci', status: 'ci_failed', headSha: 'H1', currentHeadSha: 'H2' })).toEqual([]);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: before.state, ci: before.ci, version: before.version, currentHeadSha: 'H2' });
    expect(await ciAttempts(o.deliveryId)).toEqual([]);
    expect(await tasksOf(o.deliveryId, 'ci_fix')).toEqual([]);
    expect((await prRows(o)).map((r) => r.pr_lifecycle_status)).toEqual(['ci_green', 'ci_green']);
  });
});

describe('S7 — two fix dispatches race (#3420)', () => {
  test('two concurrent drains of one dispatch_fix allocate one attempt and file one fix task', async () => {
    const o = await openAndHandOn();
    expect(await verdict(o, 'request-changes', 'H1', crashedDeps)).toMatchObject({ toState: 'CHANGES_REQUESTED' });
    await Promise.all([drain(o.deliveryId), drain(o.deliveryId), drain(o.deliveryId)]);
    const v = await loadView({ deliveryId: o.deliveryId });
    expect(v.attempts.filter((a) => a.family === 'review_fix').length).toBe(1);
    const fixes = await tasksOf(o.deliveryId, 'fix');
    expect(fixes.length).toBe(1);
    expect(fixes[0].context.workflowAttemptId).toBe(v.attempts[0].id);
  });

  test('a head move before the fix starts cancels the unclaimed fix (stale), and its ledger row', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'request-changes');
    const [fix] = await tasksOf(o.deliveryId, 'fix');
    await push(o, 'H2');
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2 });
    expect((await taskRow(fix.id)).status).toBe('cancelled');
    expect((await loadView({ deliveryId: o.deliveryId })).attempts[0]).toMatchObject({ status: 'cancelled' });
    // The stale fix task cannot be started even if a runner already held it.
    expect(await seam.claimFix((await taskRow(fix.id)).task, deps)).toMatchObject({ action: 'cancel' });
  });
});

describe('S8 — request-changes budget exhausted', () => {
  test('ESCALATED(review_exhausted) once per head; a replay escalates nothing more', async () => {
    const o = await open();
    await q(sql`UPDATE workflow_deliveries SET max_rounds = 1 WHERE id = ${o.deliveryId}::uuid`);
    const workerId = await seedWorker(o.ownerTaskId, { status: 'completed', lastCommitSha: 'H1', prNumber: o.prNumber, commitCount: 1 });
    await seam.attemptEnded({ task: ownerTask(o), workerId, status: 'completed', localHeadSha: 'H1', commitCount: 1, source: 'runner' }, deps);
    expect(await verdict(o, 'request-changes')).toMatchObject({ toState: 'ESCALATED' });
    await verdict(o, 'request-changes');
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_exhausted' });
    expect((await effects(o.deliveryId, 'escalate_exhaustion')).length).toBe(1);
    expect(exhaustions).toBe(1);
    expect(await tasksOf(o.deliveryId, 'fix')).toEqual([]);
  });
});

// ══ S9–S15: repair and landing ═══════════════════════════════════════════════

describe('S9–S15', () => {
  // Intended: an OWNER attempt reaped as lost with commits that are not on GitHub (stale-workers →
  // AttemptEnded(lost), commitCount > 0, local head unknown) lands in AWAITING_PUSH with a
  // push_recovery effect; the task is never `completed` with result.sha, and no review round is
  // queued at the old head. (Part 1 today: lost + unknown L counts as "contained", so a PR whose
  // head is still open hands on to review at the old head — the case to close.) Also the cleanup
  // route (apps/web/src/app/api/tasks/cleanup) for a delivery task.
  test('S9: the reaper ends an owner attempt whose commits never reached GitHub → AWAITING_PUSH + push_recovery; no round at the old head', async () => {
    const o = await open();
    const w = await seedWorker(o.ownerTaskId, { status: 'failed', prNumber: o.prNumber, commitCount: 2 });
    const end = () => seam.attemptEnded({ task: ownerTask(o), workerId: w, status: 'lost', localHeadSha: null, commitCount: 2, source: 'sweep:stale-workers' }, deps);
    expect((await end()).result).toMatchObject({ result: 'applied' });
    expect((await end()).result).toMatchObject({ result: 'duplicate' });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_PUSH', currentHeadSha: 'H1', currentRound: 0 });
    expect(await rounds(o.deliveryId)).toEqual([]);
    expect(reviewersCreated).toEqual([]);
    expect((await effects(o.deliveryId, 'push_recovery')).length).toBe(1);
    expect((await taskRow(o.ownerTaskId)).status).not.toBe('completed');
    // The reaped work reaches GitHub after all (recovered by hand): the local head was never
    // reported, so §9's proof is "moved off H1 and the PR's content changed" (H2 descends from H1).
    await push(o, 'H2', { ancestors: ['H1'] });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H2', currentRound: 1 });
    expect(reviewersCreated.map((r) => r.head)).toEqual(['H2']);
  });

  test('S9: a reaped CI fix that pushed nothing re-dispatches the next ledger row; the attempt is never delivered', async () => {
    const o = await openAndHandOn();
    const t = await ciRepairing(o);
    await endCi(t, 'lost', { commits: 1 });
    const rows = await ciAttempts(o.deliveryId);
    expect(rows.map((a) => [a.attemptNo, a.status, a.outcome])).toEqual([[1, 'ended', 'failed'], [2, 'queued', null]]);
    expect((await delivery(o.deliveryId)).state).toBe('REPAIRING');
    expect((await tasksOf(o.deliveryId, 'ci_fix')).length).toBe(2);
  });

  // Intended: MergeCallResult(indeterminate) stays LANDING with one verify_merge; a second merge
  // call for the same head is `duplicate` (merge:{pr}:{head}); PrMerged arrives once; the merge
  // is pinned at current_head_sha. The doors that issue it are the S10 (doors) cases below.
  test('S10 (kernel): merge indeterminate and a double merge call → LANDING pinned at the head, one verify_merge, one PrMerged', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    const land = () => applyCommand({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live(), rails: { passed: true } }, { ref: { deliveryId: o.deliveryId } });
    expect(await land()).toMatchObject({ result: 'applied' });
    expect(await land()).toMatchObject({ result: 'duplicate' });
    const [mc] = await effects(o.deliveryId, 'merge_call');
    expect(mc.dedupe_key).toMatch(new RegExp(`^merge_call:${o.deliveryId}:H1:v\\d+$`));
    const result = () => applyCommand({ type: 'MergeCallResult', actor: 'kernel', headSha: 'H1', outcome: 'indeterminate' }, { ref: { deliveryId: o.deliveryId } });
    expect(await result()).toMatchObject({ result: 'applied' });
    expect(await result()).toMatchObject({ result: 'duplicate' });
    expect((await delivery(o.deliveryId)).state).toBe('LANDING');
    expect((await effects(o.deliveryId, 'verify_merge')).length).toBe(1);
    await closeOrMerge(o, true);
    await closeOrMerge(o, true);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'MERGED', mergeCommitSha: 'M-H1' });
    expect((await transitions(o.deliveryId)).filter((t) => t.command === 'PrMerged').length).toBe(1);
  });

  // Slice C: every merge door (landPr — and through it the landing sweep —, tryAutoMergeWorkerPr,
  // the dashboard merge route, PUT /api/github/pr) keeps its rails and, for a kernel-owned PR,
  // calls landThroughKernel where it used to call GitHub. Each door's wiring (it calls this, it
  // does no post-merge work of its own) is pinned in its own unit test; this is what that call does.
  test('S10 (doors): landing a kernel-owned PR is T15 → one pinned merge call → T16 → verify_merge → PrMerged, and the post-merge work runs as effects', async () => {
    const o = await openAndHandOn();
    await q(sql`UPDATE workers SET pr_url = ${`https://github.com/${REPO}/pull/${o.prNumber}`} WHERE pr_number = ${o.prNumber}::int AND workspace_id = ${workspaceId}::uuid`);
    await verdict(o, 'approve');
    const res = await seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'auto_merge', actor: 'system:auto_merge' }, deps);
    expect(res).toMatchObject({ merged: true, outcome: 'merged', mergeCommitSha: 'M-H1' });
    expect(mergeCalls).toEqual([{ prNumber: o.prNumber, method: 'squash', sha: 'H1' }]);
    const cmds = (await transitions(o.deliveryId)).map((t) => t.command);
    expect(cmds.slice(-3)).toEqual(['LandingRequested', 'MergeCallResult', 'PrMerged']);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'MERGED', mergedAt: expect.any(String), mergeCommitSha: 'M-H1' });
    // The post-merge work: the fact cache from GitHub's merged_at (stamp_pr_rows), the owner task
    // completed by the merge (emit_pr_merged), and nothing left owed.
    const [w] = await q<{ merged_at: Date | null; pr_lifecycle_status: string | null }>(sql`SELECT merged_at, pr_lifecycle_status FROM workers WHERE task_id = ${o.ownerTaskId}::uuid AND pr_number = ${o.prNumber} ORDER BY created_at LIMIT 1`);
    expect(w.pr_lifecycle_status).toBe('merged');
    expect(new Date(w.merged_at!).toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect((await taskRow(o.ownerTaskId)).status).toBe('completed');
    const owed = (await effects(o.deliveryId)).filter((e) => ['merge_call', 'verify_merge', 'stamp_pr_rows', 'emit_pr_merged', 'finalize_mission_pr'].includes(e.kind));
    expect(owed.every((e) => e.status === 'done')).toBe(true);
    expect(owed.find((e) => e.kind === 'emit_pr_merged')!.outcome).toBe('ok');
    // A second door after the merge: the fact, not a second merge call.
    expect(await seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'merge_pr', actor: 'agent:w' }, deps))
      .toMatchObject({ merged: true, reason: 'already_merged' });
    expect(mergeCalls.length).toBe(1);
    expect((await transitions(o.deliveryId)).filter((t) => t.command === 'PrMerged').length).toBe(1);
  });

  test('S10 (doors): an indeterminate merge answer is verified before anything re-calls; nothing landed → APPROVED, and the next door lands it', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    mergeAnswer = () => ({ merged: false, message: 'Could not reach GitHub: socket hang up', indeterminate: true });
    const first = await seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'auto_merge', actor: 'system:auto_merge' }, deps);
    expect(first).toMatchObject({ merged: false, outcome: 'not_merged' });
    expect(mergeCalls.length).toBe(1);
    expect((await effects(o.deliveryId, 'verify_merge')).map((e) => e.status)).toEqual(['done']);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'APPROVED', currentHeadSha: 'H1' });
    // The answer was lost but the merge DID go through: verify reads it and records the fact.
    mergeAnswer = () => { gh.state = 'closed'; gh.merged = true; return { merged: false, message: 'GitHub returned 502 with no readable response body', indeterminate: true }; };
    const second = await seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'land_pr:sweep', actor: 'system:sweep' }, deps);
    expect(second).toMatchObject({ merged: true, outcome: 'merged' });
    expect(mergeCalls.map((c) => c.sha)).toEqual(['H1', 'H1']);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'MERGED' });
    expect((await transitions(o.deliveryId)).filter((t) => t.command === 'PrMerged').length).toBe(1);
  });

  test('S10 (doors): two doors at once land one merge — the second finds the landing in flight', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    // The first door's merge call never drains (the request died after T15 committed).
    const first = await seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'auto_merge', actor: 'system:auto_merge' }, crashedDeps);
    expect(first).toMatchObject({ merged: false, outcome: 'landing', indeterminate: true });
    expect((await delivery(o.deliveryId)).state).toBe('LANDING');
    const second = await seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'merge_pr', actor: 'agent:w' }, deps);
    expect(second).toMatchObject({ merged: true });
    expect(mergeCalls.length).toBe(1);
    expect((await effects(o.deliveryId, 'merge_call')).length).toBe(1);
  });

  test('S10 (doors): a kernel refusal is the door\'s answer; no merge call is made for a head the kernel has not approved', async () => {
    const o = await openAndHandOn(); // AWAITING_REVIEW: round 1 still open
    const res = await seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'merge_pr', actor: 'agent:w' }, deps);
    expect(res).toMatchObject({ merged: false, outcome: 'rejected', reason: 'state_not_allowed', current: { state: 'AWAITING_REVIEW' } });
    expect(mergeCalls).toEqual([]);
    // GitHub refusing for a reason no repair answers goes to a person.
    await verdict(o, 'approve');
    mergeAnswer = () => ({ merged: false, message: 'Required status check "build" is expected.' });
    const refused = await seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'auto_merge', actor: 'system:auto_merge' }, deps);
    expect(refused).toMatchObject({ merged: false, outcome: 'refused', reason: 'landing_needs_human', message: 'Required status check "build" is expected.' });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'landing_needs_human' });
    // A person merges past it from the dashboard: a new landing request at the same head, recorded as a bypass.
    gh.state = 'open'; gh.merged = false;
    mergeAnswer = () => { gh.state = 'closed'; gh.merged = true; return { merged: true, message: 'merged' }; };
    const v = (await delivery(o.deliveryId)).version;
    const human = await seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'dashboard', actor: 'human:owner', override: { reason: 'checks are advisory here' }, expectedVersion: v }, deps);
    expect(human).toMatchObject({ merged: true });
    const t15 = (await q<{ bypass: Record<string, unknown> | null }>(sql`SELECT bypass FROM workflow_transitions WHERE delivery_id = ${o.deliveryId}::uuid AND command = 'LandingRequested' ORDER BY to_version`));
    expect(t15.map((t) => t.bypass?.reason ?? null)).toEqual([null, 'checks are advisory here']);
  });

  test('S11: a person merges on GitHub while AWAITING_REVIEW → MERGED from any state; open rounds superseded; classified merged_unreviewed', async () => {
    const o = await openAndHandOn();
    await closeOrMerge(o, true);
    expect((await delivery(o.deliveryId)).state).toBe('MERGED');
    expect((await rounds(o.deliveryId))[0]).toMatchObject({ status: 'superseded', verdict: null });
    const t = (await transitions(o.deliveryId)).at(-1)!;
    expect(t).toMatchObject({ command: 'PrMerged', to_state: 'MERGED' });
    expect(t.evidence.reviewClass).toBe('merged_unreviewed');
  });

  test('S11: merged while a fix runs → the open attempt is cancelled; merged over a request-changes verdict is recorded as such', async () => {
    const f = await fixing();
    await closeOrMerge(f, true);
    const v = await loadView({ deliveryId: f.deliveryId });
    expect(v.delivery).toMatchObject({ state: 'MERGED', boundAttemptId: null });
    expect(v.attempts[0]).toMatchObject({ status: 'cancelled' });
    expect((await transitions(f.deliveryId)).at(-1)!.evidence.reviewClass).toBe('merged_over_verdict');
    // A fix worker that finishes after the merge changes nothing.
    const workerId = await seedWorker(f.fix.id, { status: 'completed', lastCommitSha: 'L2', commitCount: 1 });
    const late = await seam.attemptEnded({ task: f.fix, workerId, status: 'completed', localHeadSha: 'L2', commitCount: 1, source: 'runner' }, deps);
    expect(late.result).toMatchObject({ result: 'stale' });
    expect((await delivery(f.deliveryId)).state).toBe('MERGED');
  });

  // T20 only from CLOSED_UNMERGED, and an existing edge is never overwritten: a different target
  // reaches the reducer (the key names the target) and is refused edge_exists.
  test('S12 (kernel): T20 only from CLOSED_UNMERGED; a second, different target is refused edge_exists and never overwrites', async () => {
    const o = await openAndHandOn();
    const caller = await seedTask(workspaceId, { status: 'in_progress', title: 'friction: record the supersession' });
    const supersede = (prNumber: number, authorised = true) => applyCommand({
      type: 'SupersessionRecorded', actor: `agent:${caller}`, target: { repoFullName: REPO, prNumber, merged: true, url: null }, reason: 're-opened fresh', authorised,
    }, { ref: { deliveryId: o.deliveryId } });
    expect(await supersede(4242)).toMatchObject({ result: 'rejected', reason: 'not_closed_unmerged' });
    await closeOrMerge(o, false, 'u-closed');
    expect(await supersede(4242, false)).toMatchObject({ result: 'rejected', reason: 'not_authorised' });
    expect(await supersede(4242)).toMatchObject({ result: 'applied' });
    expect(await supersede(4242)).toMatchObject({ result: 'duplicate' });
    expect(await supersede(4343)).toMatchObject({ result: 'rejected', reason: 'edge_exists' });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'SUPERSEDED', supersededByPr: 4242 });
    const t20 = (await transitions(o.deliveryId)).filter((t) => t.command === 'SupersessionRecorded');
    expect(t20.map((t) => t.evidence.actor)).toEqual([`agent:${caller}`]);
  });

  // The write behind POST /api/github/pr/supersede and record_pr_supersession (the route's
  // authorization on the CALLER's task is S21). The kernel decides; the columns are its projection.
  test('S12: record_pr_supersession on a kernel-owned PR is T20 by the caller; the projection writes the rows; the mission reads it as shipped', async () => {
    const o = await openAndHandOn();
    const missionId = await inMission(o);
    await stampPrUrl(o);
    const caller = await seedTask(workspaceId, { status: 'in_progress', title: `friction: #${o.prNumber} landed under #4242` });
    ghApi = (path) => {
      const n = /\/pulls\/(\d+)$/.exec(path)?.[1];
      if (!n) return undefined;
      return Number(n) === o.prNumber ? { number: o.prNumber, merged: false, body: null } : mergedPr(Number(n));
    };
    const workerId = await prWorkerOf(o);
    const record = (n: number) => recordPrSupersession({ workerId, supersedingPrNumber: n, reason: 'landed under a fresh PR', recordedBy: `agent:${caller}` });

    // Open: the kernel refuses, and no column is written.
    expect(await record(4242)).toMatchObject({ ok: false, status: 409 });
    expect((await prRows(o)).every((r) => r.superseded_by_pr_number == null)).toBe(true);

    // Closed, but the close webhook was lost: the write reads GitHub, records the close, then T20.
    gh.state = 'closed'; gh.updatedAt = 'u-closed';
    expect(await record(4242)).toMatchObject({ ok: true, supersededPrNumber: o.prNumber, supersedingPrNumber: 4242, supersedingPrUrl: prUrl(4242) });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'SUPERSEDED', supersededByPr: 4242 });
    const t = await transitions(o.deliveryId);
    expect(t.slice(-2).map((x) => [x.command, x.to_state])).toEqual([['PrClosedUnmerged', 'CLOSED_UNMERGED'], ['SupersessionRecorded', 'SUPERSEDED']]);
    expect(t.at(-1)!.evidence.actor).toBe(`agent:${caller}`);
    expect((await prRows(o)).map((r) => [r.superseded_by_pr_number, r.superseded_recorded_by])).toEqual((await prRows(o)).map(() => [4242, `agent:${caller}`]));
    expect((await effects(o.deliveryId, 'project_supersession')).map((e) => e.status)).toEqual(['done']);

    // A replay is the same answer; a different target never overwrites the edge.
    expect(await record(4242)).toMatchObject({ ok: true });
    const over = await record(4343);
    expect(over).toMatchObject({ ok: false, status: 409 });
    expect((over as { error: string }).error).toContain('never overwritten');
    expect(await delivery(o.deliveryId)).toMatchObject({ supersededByPr: 4242 });

    // The mission's completion gate reads the delivery: shipped, under #4242.
    const gate = await canCompleteMission(missionId, { evaluateCriteria: false });
    expect(gate).toMatchObject({ ok: true, awaitingMerge: 0, supersededCount: 1 });
    expect(gate.supersededDetails[0]).toMatchObject({ prNumber: o.prNumber, supersededByPrNumber: 4242 });
    // T20 woke the mission: a no-op here only because the test holds it.
    expect((await effects(o.deliveryId, 'wake_mission')).map((e) => [e.status, e.outcome])).toEqual([['done', 'ok:not_woken_held']]);
  });

  test('S13: the transition and its effects commit together; a crash before the inline drain is picked up by the next drain', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'request-changes', 'H1', crashedDeps);
    const t = (await transitions(o.deliveryId)).at(-1)!;
    const fx = await effects(o.deliveryId);
    const ofT = fx.filter((e) => e.transition_id === t.id).map((e) => e.kind).sort();
    expect(ofT).toEqual(['dispatch_fix', 'post_review', 'render_activity']);
    expect(fx.filter((e) => e.transition_id === t.id).every((e) => e.status === 'pending')).toBe(true);
    expect(await tasksOf(o.deliveryId, 'fix')).toEqual([]);
    await drain(o.deliveryId);
    expect((await tasksOf(o.deliveryId, 'fix')).length).toBe(1);
  });

  test('S13: a handler that crashes mid-effect backs off and re-runs; a lease that expired is re-claimed; redelivery is idempotent', async () => {
    const o = await openAndHandOn();
    let crashes = 1;
    override.dispatch_fix = async (e) => {
      if (crashes-- > 0) throw new Error('process died mid-effect');
      return reviewEffectHandlers.dispatch_fix!(e);
    };
    await verdict(o, 'request-changes');
    let [df] = await effects(o.deliveryId, 'dispatch_fix');
    expect(df).toMatchObject({ status: 'pending', attempt_count: 1, last_error: 'process died mid-effect' });
    expect(await tasksOf(o.deliveryId, 'fix')).toEqual([]);

    await makeDue(o.deliveryId);
    await drain(o.deliveryId);
    [df] = await effects(o.deliveryId, 'dispatch_fix');
    expect(df).toMatchObject({ status: 'done', outcome: 'ok', attempt_count: 2 });
    expect((await tasksOf(o.deliveryId, 'fix')).length).toBe(1);

    // A drain that claimed it and then died: the lease expires and the next drain runs it again.
    await q(sql`UPDATE workflow_effects SET status = 'delivering', lease_until = now() - interval '1 second' WHERE id = ${df.id}::uuid`);
    await drain(o.deliveryId);
    [df] = await effects(o.deliveryId, 'dispatch_fix');
    expect(df).toMatchObject({ status: 'done', outcome: 'ok:task_exists', attempt_count: 3 });
    expect((await tasksOf(o.deliveryId, 'fix')).length).toBe(1);
    expect((await loadView({ deliveryId: o.deliveryId })).attempts.length).toBe(1);
  });

  // S14 (a sweep cannot assign state) is a static guard, not a runtime path:
  // packages/core/__tests__/workflow-write-sites.test.ts.

  // Intended: a base that keeps moving under an APPROVED delivery cycles LANDING ↔ REPAIRING(behind)
  // through mechanical refresh_branch attempts bounded by the treadmill cap (DEFAULT_MAX_MECHANICAL
  // per head), then escalates; landPr's hard gates unchanged.
  test('S15 (kernel): a base that keeps moving under an approved PR is refreshed mechanically a bounded number of times, then a person lands it', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    override.refresh_branch = async () => ({ outcome: 'ok' }); // the platform's own update-branch (no agent)
    let head = 'H1';
    for (let i = 1; i <= 3; i++) {
      expect(await applyCommand({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: head, live: live(), rails: { passed: true } }, { ref: { deliveryId: o.deliveryId } })).toMatchObject({ result: 'applied' });
      expect(await applyCommand({ type: 'MergeCallResult', actor: 'kernel', headSha: head, outcome: 'behind' }, { ref: { deliveryId: o.deliveryId } })).toMatchObject({ result: 'applied' });
      expect(await delivery(o.deliveryId)).toMatchObject({ state: 'REPAIRING', stateReason: 'behind' });
      // The refresh lands: our own mechanical push, carried forward without a new review.
      const next = `R${i}`;
      await push(o, next, { ancestors: [head], equivalent: true });
      expect(await delivery(o.deliveryId)).toMatchObject({ state: 'APPROVED', currentHeadSha: next });
      head = next;
    }
    expect(await applyCommand({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: head, live: live(), rails: { passed: true } }, { ref: { deliveryId: o.deliveryId } })).toMatchObject({ result: 'applied' });
    expect(await applyCommand({ type: 'MergeCallResult', actor: 'kernel', headSha: head, outcome: 'behind' }, { ref: { deliveryId: o.deliveryId } })).toMatchObject({ result: 'applied' });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'landing_needs_human' });
    const mech = (await loadView({ deliveryId: o.deliveryId })).attempts.filter((a) => a.mode === 'mechanical');
    expect(mech.map((a) => [a.attemptNo, a.outcome])).toEqual([[1, 'delivered'], [1, 'delivered'], [1, 'delivered']].map(([, out], i) => [i + 1, out]));
    expect(reviewersCreated.length).toBe(1);
  });

  // Intended: landPr and the landing sweep raise MergeCallResult(behind) from their real merge call,
  // and the refresh_branch effect runs pr-branch-update with its expected_head (§6.7).
  test('S15 (refresh_branch): the platform refresh is GitHub update-branch pinned to the bound head; the refreshed head keeps the approval', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    gh.mergeable = 'behind';
    updateBranch({ merged: 'R1' });
    expect(await conflictDoor(o, { behindOnly: true })).toMatchObject({ dispatched: true, branchUpdated: true });
    const put = ghWrites.find((w) => w.path.endsWith('/update-branch'))!;
    expect(put).toMatchObject({ method: 'PUT', path: `/repos/${REPO}/pulls/${o.prNumber}/update-branch`, body: { expected_head_sha: 'H1' } });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'APPROVED', currentHeadSha: 'R1', approvedHeads: ['H1', 'R1'] });
    expect((await repairAttempts(o.deliveryId)).map((a) => [a.mode, a.status, a.outcome, a.taskId])).toEqual([['mechanical', 'ended', 'delivered', null]]);
    expect(reviewersCreated.length).toBe(1);
  });

  // Slice C: a door's real merge call answered "behind" is T16, and refresh_branch runs the
  // pinned update-branch (pr-branch-update.ts) with its expected_head (§6.7). Our own refresh
  // carries the approval forward, the next door lands it; the treadmill cap still bounds it.
  test('S15 (doors): a merge refused as behind is refreshed mechanically by refresh_branch, pinned to the head; the refreshed head lands', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    const land = (head: string) => seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: head, door: 'land_pr:sweep', actor: 'system:sweep' }, deps);
    mergeAnswer = () => ({ merged: false, message: 'Base branch was modified. Review and try the merge again.' });
    expect(await land('H1')).toMatchObject({ merged: false, outcome: 'behind' });
    expect(updateBranchCalls).toEqual([{ path: `/repos/${REPO}/pulls/${o.prNumber}/update-branch`, expectedHead: 'H1' }]);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'REPAIRING', stateReason: 'behind' });
    const [mech] = (await loadView({ deliveryId: o.deliveryId })).attempts.filter((a) => a.mode === 'mechanical');
    expect(mech).toMatchObject({ family: 'conflict', attemptNo: 1, boundHeadSha: 'H1', taskId: null });
    expect((await effects(o.deliveryId, 'refresh_branch')).map((e) => e.outcome)).toEqual(['ok:updated']);
    // GitHub's update-branch lands as a new head; it is the platform's own refresh.
    await push(o, 'R1', { ancestors: ['H1'], equivalent: true });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'APPROVED', currentHeadSha: 'R1' });
    mergeAnswer = () => { gh.state = 'closed'; gh.merged = true; return { merged: true, message: 'merged' }; };
    expect(await land('R1')).toMatchObject({ merged: true });
    expect(mergeCalls.map((c) => c.sha)).toEqual(['H1', 'R1']);
    expect(reviewersCreated.length).toBe(1);
  });

  test('S15 (doors): an update-branch GitHub refuses with a conflict hands the repair to an agent attempt; a branch already current resumes landing', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    const land = () => seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'auto_merge', actor: 'system:auto_merge' }, deps);
    mergeAnswer = () => ({ merged: false, message: 'Head branch is out of date' });
    updateBranchError = 'GitHub API error: 422 {"message":"There are no new commits on the base branch."}';
    expect(await land()).toMatchObject({ merged: false });
    // Nothing to refresh after all: the mechanical row is skipped (spends nothing) and the approval stands.
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'APPROVED', currentHeadSha: 'H1' });
    expect((await loadView({ deliveryId: o.deliveryId })).attempts.map((a) => [a.mode, a.status])).toEqual([['mechanical', 'skipped']]);
    updateBranchError = 'GitHub API error: 422 {"message":"merge conflict between base and head"}';
    override.dispatch_conflict_fix = async () => ({ outcome: 'ok:dispatched:test' }); // the conflict family's own dispatcher (Slice B)
    expect(await land()).toMatchObject({ merged: false, outcome: 'conflict' });
    const v = await loadView({ deliveryId: o.deliveryId });
    expect(v.delivery).toMatchObject({ state: 'REPAIRING', stateReason: 'conflict' });
    expect(v.attempts.map((a) => [a.mode, a.attemptNo, a.status, a.outcome])).toEqual([
      ['agent', 1, 'queued', null], ['mechanical', 1, 'skipped', 'noop'], ['mechanical', 2, 'ended', 'failed'],
    ]);
    expect((await effects(o.deliveryId, 'dispatch_conflict_fix')).map((e) => e.status)).toEqual(['done']);
  });
});

// ══ S16–S21: projections and authorization ═══════════════════════════════════

describe('S16–S21', () => {
  // canCompleteMission's rules are unchanged (mission-task-lifecycle ACs, mission-completion.test.ts);
  // what changed is its input: a kernel-owned PR answers from the delivery, a legacy one from its columns.
  test('S16: the completion gate reads the delivery for a kernel-owned PR (merged before its stamp, closed, abandoned) and the columns for a legacy one', async () => {
    // Merged by the kernel; the stamp_pr_rows projection has not run yet.
    const merged = await openAndHandOn();
    const m1 = await inMission(merged);
    await stampPrUrl(merged);
    await closeOrMerge(merged, true, 'u-merged');
    await q(sql`UPDATE workflow_effects SET status = 'pending' WHERE delivery_id = ${merged.deliveryId}::uuid AND kind = 'stamp_pr_rows'`);
    await q(sql`UPDATE workers SET merged_at = NULL, pr_lifecycle_status = 'pr_open' WHERE pr_number = ${merged.prNumber} AND workspace_id = ${workspaceId}::uuid`);
    expect(await canCompleteMission(m1, { evaluateCriteria: false })).toMatchObject({ ok: true, awaitingMerge: 0 });

    // Closed unmerged: blocks as closed with no supersession, until a person abandons it (T21).
    gh = { head: 'H1', state: 'open', merged: false, updatedAt: 'u0', ancestors: {} };
    const closed = await openAndHandOn();
    const m2 = await inMission(closed);
    await stampPrUrl(closed);
    await closeOrMerge(closed, false, 'u-closed');
    const blocked = await canCompleteMission(m2, { evaluateCriteria: false });
    expect(blocked).toMatchObject({ ok: false, code: 'awaiting_merge' });
    expect(blocked.awaitingMergeDetails[0].closedUnsuperseded).toBe(true);
    expect(await recordPrAbandonment({ workerId: await prWorkerOf(closed), reason: 'plan changed', recordedBy: 'owner@example.com' })).toEqual({ ok: true });
    expect(await delivery(closed.deliveryId)).toMatchObject({ state: 'ABANDONED', stateReason: 'plan changed' });
    expect((await transitions(closed.deliveryId)).at(-1)!.evidence.actor).toBe('human:owner@example.com');
    expect((await prRows(closed)).every((r) => r.abandoned_reason === 'plan changed' && r.abandoned_recorded_by === 'owner@example.com')).toBe(true);
    const settled = await canCompleteMission(m2, { evaluateCriteria: false });
    expect(settled).toMatchObject({ ok: true, awaitingMerge: 0 });
    expect(settled.abandonedDetails).toEqual([{ taskId: closed.ownerTaskId, title: 'feat: matrix owner', prNumber: closed.prNumber, abandonedReason: 'plan changed' }]);

    // Legacy (no delivery): exactly the column answer, open PR blocks, closed+abandoned settles.
    const legacyTask = await seedTask(workspaceId, { status: 'completed', title: 'legacy deliverable' });
    const legacyPr = prSeq++;
    await seedWorker(legacyTask, { status: 'completed', prNumber: legacyPr });
    await q(sql`UPDATE workers SET pr_url = ${prUrl(legacyPr)}, pr_lifecycle_status = 'pr_open' WHERE task_id = ${legacyTask}::uuid`);
    const [m3] = await q<{ id: string }>(sql`INSERT INTO missions (team_id, workspace_id, title) VALUES (${teamId}::uuid, ${workspaceId}::uuid, 'legacy mission') RETURNING id`);
    await q(sql`UPDATE tasks SET mission_id = ${m3.id}::uuid WHERE id = ${legacyTask}::uuid`);
    expect(await canCompleteMission(m3.id, { evaluateCriteria: false })).toMatchObject({ ok: false, code: 'awaiting_merge' });
    await q(sql`UPDATE workers SET pr_lifecycle_status = 'closed', abandoned_at = now(), abandoned_reason = 'legacy drop' WHERE task_id = ${legacyTask}::uuid`);
    expect(await canCompleteMission(m3.id, { evaluateCriteria: false })).toMatchObject({ ok: true });
  });

  // Intended: one DeliveryView per delivery drives the Home chip, task card stage, mission strip,
  // explain and chat dock; a table of states (every §4 state × owner) renders the same stage label
  // on all five surfaces.
  test('S17: one DeliveryView drives the Home card, the task header and the mission failure reading', async () => {
    const a = await awaitingPush();
    const v = (await getDeliveryViewsForTasks([a.ownerTaskId, a.fix.id]));
    // The owner task and its attempt resolve to the same view.
    expect(v.get(a.fix.id)).toEqual(v.get(a.ownerTaskId));
    const view = v.get(a.ownerTaskId)!;
    const [card] = buildActionQueue([], [{
      workerId: 'w', taskId: a.ownerTaskId, taskTitle: 't', workspaceId, workspaceName: 'm', prNumber: a.prNumber, prUrl: 'u', policyTier: 'agent-review',
      escalationReason: null, waitingMinutes: 1, prOpenedAt: new Date(), prLifecycleVerifiedAt: new Date(), prLifecycleStatus: 'ci_green', prLifecycleUpdatedAt: new Date(),
    } as never], { deliveryViews: v });
    const header = renderToStaticMarkup(createElement(HeaderStatusPill, { status: 'waiting_on_you', merged: false, delivery: { headline: view.headline, owner: view.owner, needsYou: view.needsYou, stage: view.stage, detail: view.detail } }));
    expect(card.delivery?.headline).toBe(view.headline);
    expect(header).toContain(view.headline);
    expect(header).toContain(`data-owner="${view.owner}"`);

    // Slice E: the task card stage, mission strip tile, mission feed, chat dock, chat tile,
    // PR pill and explain's state chain all read the same view. The worker columns say
    // "CI green" on purpose; no surface may echo them.
    await q(sql`UPDATE workers SET pr_lifecycle_status = 'ci_green' WHERE task_id = ${a.ownerTaskId}::uuid`);
    const displays = await getOwnerDeliveryDisplays([a.ownerTaskId, a.fix.id]);
    expect([...displays.keys()]).toEqual([a.ownerTaskId]);
    const d = displays.get(a.ownerTaskId)!;
    expect(d).toMatchObject({ state: view.state, headline: view.headline, needsYou: false });
    expect(deriveStage({ taskStatus: 'completed', prUrl: 'u', prLifecycleStatus: 'ci_green', delivery: d })).toBe('FIXING');
    expect(boardStatusForDelivery(d)).toBe('running');
    expect(feedStateForDelivery(d)).toEqual({ state: 'moving', needsYou: null });
    // One label on every surface (deliveryReading): the push has not reached GitHub yet.
    expect(dockToneForDelivery(d)).toMatchObject({ label: 'Waiting for push', tone: 'live' });
    expect(deriveStageReading({ taskStatus: 'completed', prUrl: 'u', prLifecycleStatus: 'ci_green', delivery: d }).label).toBe('Waiting for push');
    expect(resolvePrDisplayState({ delivery: d, prLifecycleStatus: 'ci_green' })).not.toBe('ci_passed');
    const ex = (await explainTask(a.ownerTaskId, { kind: 'admin', accountId: null } as never))!.subjects[0];
    expect(ex.delivery).toMatchObject({ state: view.state, headline: view.headline, owner: view.owner });
    const link = ex.because.find((l) => l.derivedFrom === 'DeliveryView.lastTransition');
    expect(link?.claim).toContain(`Delivery is ${view.state}`);
    expect(link?.refs.prNumber).toBe(a.prNumber);
    // Explain's state chain reads the delivery, not the columns: with the owner row completed
    // and a stale merge stamp on its worker, the legacy reading was "completed"; the kernel
    // says the PR is still waiting for its fix to land, and nothing is waiting on you.
    await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${a.ownerTaskId}::uuid`);
    await q(sql`UPDATE workers SET merged_at = now() WHERE task_id = ${a.ownerTaskId}::uuid`);
    const ex2 = (await explainTask(a.ownerTaskId, { kind: 'admin', accountId: null } as never))!.subjects[0];
    expect(ex2.state).not.toBe('completed');
    expect(ex2.waitingOn).toBeNull();
    expect(ex2.because.some((l) => l.derivedFrom === 'DeliveryView.lastTransition')).toBe(true);
    expect(ex2.history.find((h) => h.taskId === a.ownerTaskId)?.prState).toBe('open');

    // A legacy-owned delivery is absent: every surface keeps today's projection.
    await q(sql`UPDATE workflow_deliveries SET authority = 'legacy' WHERE id = ${a.deliveryId}::uuid`);
    expect((await getDeliveryViewsForTasks([a.ownerTaskId])).size).toBe(0);
  });

  test('S18 (part 1): a PR closed under an open fix → CLOSED_UNMERGED, open attempts cancelled; T20 only from CLOSED_UNMERGED and never overwrites', async () => {
    const f = await fixing();
    await closeOrMerge(f, false, 'u-closed');
    const v = await loadView({ deliveryId: f.deliveryId });
    expect(v.delivery).toMatchObject({ state: 'CLOSED_UNMERGED', stateReason: 'unknown', boundAttemptId: null });
    expect(v.attempts[0]).toMatchObject({ status: 'cancelled' });

    gh = { head: 'H1', state: 'open', merged: false, updatedAt: 'u0', ancestors: {} };
    const other = await openAndHandOn();
    const supersede = (o: Delivery, prNumber: number) => applyCommand({
      type: 'SupersessionRecorded', actor: `agent:${o.ownerTaskId}`, target: { repoFullName: REPO, prNumber, merged: true, url: null }, reason: 're-opened fresh', authorised: true,
    }, { ref: { deliveryId: o.deliveryId } });
    expect(await supersede(other, 1)).toMatchObject({ result: 'rejected', reason: 'not_closed_unmerged' });
    expect(await supersede(f, 4242)).toMatchObject({ result: 'applied' });
    expect(await supersede(f, 4242)).toMatchObject({ result: 'duplicate' });
    // A different target never overwrites the edge: refused, and the record_pr_supersession
    // write answers 409 with that reason (S12).
    expect(await supersede(f, 4343)).toMatchObject({ result: 'rejected', reason: 'edge_exists' });
    expect(await delivery(f.deliveryId)).toMatchObject({ state: 'SUPERSEDED', supersededByPr: 4242 });
  });

  test('S18 (part 1): a closed PR that reopens comes back to review at its live head', async () => {
    const o = await openAndHandOn();
    await closeOrMerge(o, false, 'u-closed');
    gh.state = 'open'; gh.updatedAt = 'u-reopened'; gh.head = 'H2';
    await seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'webhook:reopened' }, deps);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H2', currentRound: 2 });
  });

  // The cause of the PR #3744 closure: the mission integration branch was deleted under an open
  // task PR, and the work was re-opened as a fresh PR that merged.
  test('S18: integration branch deleted → CLOSED_UNMERGED(base_deleted); scan_supersession proves the re-opened PR and T20 records it', async () => {
    gh.baseRef = 'mission/matrix-x';
    const o = await openAndHandOn();
    await stampPrUrl(o);
    const reopened = prSeq++;
    const patch = '@@ -0,0 +1,4 @@\n' + [
      'export function settleClosedPr(id: string) {', '  return lookupDelivery(id).resolution;', '}', 'export const SETTLE_LIMIT = 17;',
    ].map((l) => `+${l}`).join('\n');
    ghApi = (path) => {
      if (path === `/repos/${REPO}/pulls/${o.prNumber}`) return { number: o.prNumber, merged: false, commits: 1, created_at: '2026-10-01T00:00:00Z', body: `Base branch was deleted; re-opened as #${reopened}. Superseded by #${reopened}.` };
      if (path.startsWith(`/repos/${REPO}/pulls/${o.prNumber}/files`)) return [{ filename: 'src/settle.ts', status: 'added', patch }];
      if (path === `/repos/${REPO}/pulls/${reopened}`) return mergedPr(reopened);
      if (path.startsWith(`/repos/${REPO}/pulls/${reopened}/files`)) return [{ filename: 'src/settle.ts', status: 'added', patch }];
      return undefined;
    };
    // GitHub closes the PR because its base is gone; the live branch read says so.
    gh.baseExists = false;
    await closeOrMerge(o, false, 'u-base-gone');

    const t = await transitions(o.deliveryId);
    expect(t.slice(-2).map((x) => [x.command, x.to_state])).toEqual([['PrClosedUnmerged', 'CLOSED_UNMERGED'], ['SupersessionRecorded', 'SUPERSEDED']]);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'SUPERSEDED', stateReason: 'base_deleted', supersededByPr: reopened });
    expect(t.at(-1)!.evidence.actor).toBe('system:auto-supersession');
    expect((await effects(o.deliveryId, 'scan_supersession')).map((e) => [e.status, e.outcome])).toEqual([['done', 'ok:recorded']]);
    expect((await prRows(o)).every((r) => r.superseded_by_pr_number === reopened && r.superseded_recorded_by === 'system:auto-supersession')).toBe(true);
    const [gate] = await q<{ outcome: string; surface: string }>(sql`SELECT outcome, surface FROM gate_events WHERE worker_id = ${await prWorkerOf(o)}::uuid AND gate = 'auto_pr_supersession'`);
    expect(gate).toMatchObject({ outcome: 'accepted', surface: 'workflow scan_supersession' });

    // A close whose base still exists is not guessed to be anything.
    gh = { head: 'H1', state: 'open', merged: false, updatedAt: 'u0', ancestors: {}, baseRef: 'dev', baseExists: true };
    ghApi = null;
    const manual = await openAndHandOn();
    await closeOrMerge(manual, false, 'u-closed');
    expect(await delivery(manual.deliveryId)).toMatchObject({ state: 'CLOSED_UNMERGED', stateReason: 'unknown' });
  });

  test('S19: fix worker killed after claim → CHANGES_REQUESTED, ledger row failed, the next attempt_no dispatched; the last one exhausts', async () => {
    const o = await open();
    await q(sql`UPDATE workflow_deliveries SET max_rounds = 2 WHERE id = ${o.deliveryId}::uuid`);
    const ow = await seedWorker(o.ownerTaskId, { status: 'completed', lastCommitSha: 'H1', prNumber: o.prNumber, commitCount: 1 });
    await seam.attemptEnded({ task: ownerTask(o), workerId: ow, status: 'completed', localHeadSha: 'H1', commitCount: 1, source: 'runner' }, deps);
    const f = await fixing(o);

    const w1 = await seedWorker(f.fix.id, { status: 'failed' });
    await seam.attemptEnded({ task: f.fix, workerId: w1, status: 'lost', localHeadSha: null, commitCount: 2, source: 'sweep:stale-workers' }, deps);
    let v = await loadView({ deliveryId: o.deliveryId });
    expect(v.delivery!.state).toBe('CHANGES_REQUESTED');
    expect(v.attempts.map((a) => [a.attemptNo, a.status, a.outcome])).toEqual([[1, 'ended', 'failed'], [2, 'queued', null]]);
    const fixes = await tasksOf(o.deliveryId, 'fix');
    expect(fixes.length).toBe(2);
    expect(fixes[1].context).toMatchObject({ iteration: 2, maxIterations: 2, workflowAttemptId: v.attempts[1].id });

    const t2 = (await taskRow(fixes[1].id)).task;
    expect(await seam.claimFix(t2, deps)).toEqual({ action: 'proceed' });
    const w2 = await seedWorker(t2.id, { status: 'failed' });
    await seam.attemptEnded({ task: t2, workerId: w2, status: 'failed', localHeadSha: null, commitCount: 0, source: 'runner' }, deps);
    v = await loadView({ deliveryId: o.deliveryId });
    expect(v.delivery).toMatchObject({ state: 'ESCALATED', stateReason: 'review_exhausted' });
    expect((await tasksOf(o.deliveryId, 'fix')).length).toBe(2);
  });

  test('S19 variant (ea38b3d5): a fix that pushed mid-attempt and then died → a review round at the pushed head, not a stranded CHANGES_REQUESTED', async () => {
    const f = await fixing();
    await push(f, 'H2', { ancestors: ['H1'] });
    expect(await delivery(f.deliveryId)).toMatchObject({ state: 'FIXING', currentHeadSha: 'H2' });
    const before = reviewersCreated.length;

    const w = await seedWorker(f.fix.id, { status: 'failed' });
    await seam.attemptEnded({ task: f.fix, workerId: w, status: 'lost', localHeadSha: null, commitCount: 1, source: 'sweep:stale-workers' }, deps);
    const v = await loadView({ deliveryId: f.deliveryId });
    expect(v.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H2', currentRound: 2, boundAttemptId: null });
    expect(v.rounds.find((r) => r.round === 2)).toMatchObject({ headSha: 'H2', kind: 'delta', status: 'queued' });
    expect(v.attempts.map((a) => [a.attemptNo, a.status, a.outcome])).toEqual([[1, 'ended', 'failed']]);
    // The pushed head is under review; no second fix was filed for the stale round.
    expect(reviewersCreated.slice(before).map((r) => [r.round, r.head])).toEqual([[2, 'H2']]);
    expect((await tasksOf(f.deliveryId, 'fix')).length).toBe(1);
  });

  test('S20 (kernel): a stale version from a human action is answered stale with the current view; nothing applies', async () => {
    const o = await open();
    await q(sql`UPDATE workflow_deliveries SET max_rounds = 1 WHERE id = ${o.deliveryId}::uuid`);
    const ow = await seedWorker(o.ownerTaskId, { status: 'completed', lastCommitSha: 'H1', prNumber: o.prNumber, commitCount: 1 });
    await seam.attemptEnded({ task: ownerTask(o), workerId: ow, status: 'completed', localHeadSha: 'H1', commitCount: 1, source: 'runner' }, deps);
    await verdict(o, 'request-changes');
    const d = await delivery(o.deliveryId);
    expect(d.state).toBe('ESCALATED');
    const n = (await transitions(o.deliveryId)).length;

    const resolve = (expectedVersion: number) => applyCommand({ type: 'HumanResolve', actor: 'human:owner', choice: 'approve', expectedVersion }, { ref: { deliveryId: o.deliveryId } });
    expect(await resolve(d.version - 1)).toEqual({ result: 'stale', reason: 'version_moved', current: { state: 'ESCALATED', version: d.version, head: 'H1', round: 1 } });
    expect((await transitions(o.deliveryId)).length).toBe(n);
    expect(await resolve(d.version)).toMatchObject({ result: 'applied' });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'APPROVED', approvalBasis: 'human', approvedHeads: ['H1'] });
  });

  // T23 (task eee04322): Apply on a kernel PR's escalation is HumanResolve(apply_recommendation).
  // The route's whole kernel path is this seam call (route test for /api/prs/[prNumber]/apply-recommendation).
  const applyRec = (o: Delivery, expectedVersion: number | undefined, instructions: string | null = null) =>
    seam.applyRecommendationThroughKernel({ workspaceId, prNumber: o.prNumber, actor: 'human:owner', expectedVersion, instructions }, deps);
  const bypassOf = async (deliveryId: string, command: string) => (await q<{ bypass: Record<string, unknown> | null; actor: string }>(
    sql`SELECT bypass, actor FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid AND command = ${command} ORDER BY to_version DESC LIMIT 1`))[0];

  test('T23: Apply on a reviewer escalation dispatches the fix through the kernel: human ledger row, instructions in the task, then the normal claim', async () => {
    const o = await openAndHandOn();
    const reviewer = await reviewerOf(o.deliveryId);
    await q(sql`UPDATE tasks SET result = ${JSON.stringify({ structuredOutput: { verdict: 'escalate', escalationReason: 'The schema changed with no generated migration.' } })}::jsonb WHERE id = ${reviewer.id}::uuid`);
    await verdict(o, 'escalate');
    const d = await delivery(o.deliveryId);
    expect(d).toMatchObject({ state: 'ESCALATED', stateReason: 'review_escalated' });

    const out = await applyRec(o, d.version, 'Generate the migration with bun db:generate and commit it.');
    expect(out!.result).toMatchObject({ result: 'applied' });
    // The person and the bypass are on T23's own transition.
    expect(await bypassOf(o.deliveryId, 'HumanResolve')).toMatchObject({ actor: 'human:owner', bypass: { choice: 'apply_recommendation', actor: 'human:owner', escalation: 'review_escalated' } });
    // One review_fix ledger row, trigger=human, against the escalated round.
    const v = await loadView({ deliveryId: o.deliveryId });
    const fixes = v.attempts.filter((a) => a.family === 'review_fix');
    expect(fixes.map((a) => [a.attemptNo, a.trigger, a.status, a.boundHeadSha])).toEqual([[1, 'human', 'queued', 'H1']]);
    expect(v.delivery).toMatchObject({ state: 'CHANGES_REQUESTED', stateReason: null });
    // The kernel's fix task carries the instructions (authoritative) and the reviewer's words (context).
    const [fix] = await tasksOf(o.deliveryId, 'fix');
    expect(out!.attempt).toMatchObject({ attemptNo: 1, taskId: fix.id });
    expect(fix.creation_source).toBe('dashboard');
    expect(fix.context).toMatchObject({ trigger: 'human', appliedBy: 'human:owner', humanInstructions: 'Generate the migration with bun db:generate and commit it.', workflowAttemptId: fixes[0].id });
    const [{ description }] = await q<{ description: string }>(sql`SELECT description FROM tasks WHERE id = ${fix.id}::uuid`);
    expect(description).toContain('Generate the migration with bun db:generate and commit it.');
    expect(description).toContain('The schema changed with no generated migration.');
    expect(description.indexOf('Generate the migration')).toBeLessThan(description.indexOf('The schema changed'));
    // Nothing on the legacy path: the only fix task is the delivery's own.
    const legacy = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM tasks WHERE workspace_id = ${workspaceId}::uuid AND reviewer_retry_pr_number = ${o.prNumber} AND delivery_id IS NULL`);
    expect(legacy[0].n).toBe(0);
    // And the fix claims like any other.
    expect(await seam.claimFix((await taskRow(fix.id)).task, deps)).toEqual({ action: 'proceed' });
    expect((await delivery(o.deliveryId)).state).toBe('FIXING');
  });

  test('T23: a stale version is answered stale with the current view; nothing is dispatched', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'escalate');
    const d = await delivery(o.deliveryId);
    const n = (await transitions(o.deliveryId)).length;
    const out = await applyRec(o, d.version - 1);
    expect(out!.result).toEqual({ result: 'stale', reason: 'version_moved', current: { state: 'ESCALATED', version: d.version, head: 'H1', round: 1 } });
    expect(out!.current).toMatchObject({ state: 'ESCALATED', stateReason: 'review_escalated', version: d.version });
    expect(out!.attempt).toBeNull();
    expect((await transitions(o.deliveryId)).length).toBe(n);
    expect(await tasksOf(o.deliveryId, 'fix')).toEqual([]);
    // A push that lands while the card is open moves the version too.
    gh.head = 'H2'; gh.ancestors.H2 = ['H1'];
    expect((await applyRec(o, d.version))!.result).toMatchObject({ result: 'stale' });
    expect(await tasksOf(o.deliveryId, 'fix')).toEqual([]);
  });

  test('T23: an exhausted review budget is applied as a human attempt with no version from the card', async () => {
    const o = await openAndHandOn();
    await q(sql`UPDATE workflow_deliveries SET max_rounds = 1 WHERE id = ${o.deliveryId}::uuid`);
    await verdict(o, 'request-changes');
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_exhausted' });
    const out = await applyRec(o, undefined);
    expect(out!.result).toMatchObject({ result: 'applied' });
    const v = await loadView({ deliveryId: o.deliveryId });
    expect(v.attempts.filter((a) => a.family === 'review_fix').map((a) => [a.attemptNo, a.trigger, a.maxAttempts])).toEqual([[1, 'human', 1]]);
    expect((await tasksOf(o.deliveryId, 'fix')).length).toBe(1);
    // A second click is not a second fix: the delivery left ESCALATED.
    expect((await applyRec(o, undefined))!.result).toMatchObject({ result: 'stale', reason: 'state_moved' });
    expect((await tasksOf(o.deliveryId, 'fix')).length).toBe(1);
  });

  test('T23: a legacy PR is not the kernel door', async () => {
    expect(await seam.applyRecommendationThroughKernel({ workspaceId, prNumber: 999_999, actor: 'human:owner' }, deps)).toBeNull();
  });

  // Slice C: the merge doors carry the version a person saw. The routes answer HTTP 409 with this
  // `current` (route tests for /api/prs/[prNumber]/merge and PUT /api/github/pr); this is the kernel
  // side on real Postgres: a stale version is told so before any rail acts, and nothing applies.
  test('S20 (doors): a merge on a stale version is refused with the current view; nothing applies and no merge call is made', async () => {
    const o = await openAndHandOn();
    const seen = (await delivery(o.deliveryId)).version;
    await verdict(o, 'approve');
    const now = await delivery(o.deliveryId);
    expect(now.version).toBeGreaterThan(seen);
    const current = { state: 'APPROVED', version: now.version, head: 'H1', round: 1 };
    // The routes' check before any rail runs.
    expect(await seam.staleLandingVersion({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, expectedVersion: seen })).toEqual(current);
    expect(await seam.staleLandingVersion({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, expectedVersion: now.version })).toBeNull();
    expect(await seam.staleLandingVersion({ workspaceId, repoFullName: REPO, prNumber: o.prNumber })).toBeNull();
    // And the CAS at T15 itself, for a screen that went stale after that check.
    const n = (await transitions(o.deliveryId)).length;
    const res = await seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'dashboard', actor: 'human:owner', expectedVersion: seen }, deps);
    expect(res).toMatchObject({ merged: false, outcome: 'stale', reason: 'version_moved', current });
    expect((await transitions(o.deliveryId)).length).toBe(n);
    expect(mergeCalls).toEqual([]);
    expect(await seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'dashboard', actor: 'human:owner', expectedVersion: now.version }, deps))
      .toMatchObject({ merged: true });
  });

  // §17.1 on real rows: who may record T20 is decided on the CALLER's own task. The routes apply
  // this rule (apps/web/src/app/api/github/pr/supersede/route.test.ts and .../pr/review/route.test.ts
  // run the full matrix: owner, caller-names-PR, sibling, other workspace, a person, other team).
  test('S21: the caller\'s own task decides (owner, names it, retry subject, sibling, other workspace); T20 records the caller', async () => {
    const o = await openAndHandOn();
    await q(sql`UPDATE tasks SET description = ${`Opens #${o.prNumber}.`} WHERE id = ${o.ownerTaskId}::uuid`);
    const names = await seedTask(workspaceId, { status: 'in_progress', title: `friction: #${o.prNumber} shipped elsewhere` });
    const retry = await seedTask(workspaceId, { status: 'in_progress', title: 'fix review' });
    await q(sql`UPDATE tasks SET reviewer_retry_pr_number = ${o.prNumber} WHERE id = ${retry}::uuid`);
    const sibling = await seedTask(workspaceId, { status: 'in_progress', title: 'sibling work on the same files' });
    const elsewhere = (await seedWorkspace()).workspaceId;
    const foreign = await seedTask(elsewhere, { status: 'in_progress', title: `see #${o.prNumber}` });
    const may = (taskId: string, ws = workspaceId) => taskScopeTaskNamesPr({ taskScope: { taskId, workspaceId: ws, expiresAt: Date.now() + 60_000 } }, { workspaceId, prNumber: o.prNumber });

    expect(await may(o.ownerTaskId)).toBe(true);
    expect(await may(names)).toBe(true);
    expect(await may(retry)).toBe(true);
    // The owner's task names the PR; that gives the sibling nothing.
    expect(await may(sibling)).toBe(false);
    expect(await may(foreign, elsewhere)).toBe(false);
    expect(await taskScopeTaskNamesPr({}, { workspaceId, prNumber: o.prNumber })).toBe(false);

    gh.state = 'closed'; gh.updatedAt = 'u-closed';
    await stampPrUrl(o);
    ghApi = (path) => path === `/repos/${REPO}/pulls/5151` ? mergedPr(5151) : undefined;
    expect(await recordPrSupersession({ workerId: await prWorkerOf(o), supersedingPrNumber: 5151, reason: 'shipped elsewhere', recordedBy: `agent:${names}` })).toMatchObject({ ok: true });
    expect((await transitions(o.deliveryId)).filter((x) => x.command === 'SupersessionRecorded').map((x) => x.evidence.actor)).toEqual([`agent:${names}`]);
  });
});

// ══ S22–S31: recovery, ledgers and hand-off ══════════════════════════════════

describe('S22 — kill switch', () => {
  async function setKernel(on: boolean | null) {
    await q(sql`UPDATE workspaces SET git_config = ${on === null ? null : JSON.stringify({ workflowKernel: on })}::jsonb WHERE id = ${workspaceId}::uuid`);
  }

  test('a PR with no delivery is untouched by every seam function', async () => {
    const prNumber = prSeq++;
    const legacyTask = { id: await seedTask(workspaceId, { status: 'in_progress' }), workspaceId, deliveryId: null, deliveryRole: null, context: null };
    expect(await seam.observeHead({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, hintedHeadSha: 'X', source: 'webhook:synchronize' }, deps)).toBe(false);
    expect(await seam.observePrState({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, source: 'webhook:closed' }, deps)).toBe(false);
    expect(await seam.requestReview({ workspaceId, repoFullName: REPO, prNumber, installationId: 1, forced: false, actor: 'kernel' }, deps)).toEqual({ handled: false });
    expect(await seam.attemptEnded({ task: legacyTask, workerId: 'w', status: 'completed', localHeadSha: 'X', commitCount: 1, source: 'runner' }, deps)).toEqual({ handled: false });
    expect(await seam.fixCompletionGate({ task: { ...legacyTask, deliveryRole: 'fix' }, localHeadSha: 'X' }, deps)).toBeNull();
    expect(await seam.claimFix(legacyTask, deps)).toEqual({ action: 'proceed' });
    expect(await seam.recordReviewVerdict({ reviewerTask: legacyTask, verdict: 'approve', effectiveVerdict: 'approve', headSha: 'X', confidence: 1 }, deps)).toEqual({ handled: false });
    const facts = await q(sql`SELECT 1 FROM workflow_facts WHERE workspace_id = ${workspaceId}::uuid AND pr_number = ${prNumber}`);
    expect(facts).toEqual([]);
  });

  test('switched off: a mid-fix delivery is released (sticky), its fix runs on legacy, and no new delivery opens', async () => {
    const f = await fixing();
    await setKernel(false);
    try {
      expect(await kernelDeliveryForPr(workspaceId, REPO, f.prNumber)).toBeNull();
      expect(await seam.fixCompletionGate({ task: f.fix, localHeadSha: 'L2' }, deps)).toBeNull();
      const w = await seedWorker(f.fix.id, { status: 'completed', lastCommitSha: 'L2', commitCount: 1 });
      expect(await seam.attemptEnded({ task: f.fix, workerId: w, status: 'completed', localHeadSha: 'L2', commitCount: 1, source: 'runner' }, deps)).toEqual({ handled: false });
      const other = await seedTask(workspaceId, { status: 'in_progress' });
      expect(await seam.openKernelDelivery({ workspaceId, ownerTaskId: other, repoFullName: REPO, prNumber: prSeq++, installationId: 1, source: 'test' }, deps))
        .toMatchObject({ owned: false, reason: 'kernel_off' });
    } finally {
      await setKernel(null);
    }
    expect(await kernelDeliveryForPr(workspaceId, REPO, f.prNumber)).toBeNull();
    expect(await delivery(f.deliveryId)).toMatchObject({ state: 'FIXING', authority: 'legacy' });
  });
});

describe('S23 — CI provenance', () => {
  test('S23 (review family): mid-fix pushes are attributed by SHA set, not author; the delivered head is the attempt\'s', async () => {
    const f = await fixing();
    await push(f, 'P1', { ancestors: ['H1'] });
    await push(f, 'P2', { ancestors: ['H1', 'P1'] });
    let v = await loadView({ deliveryId: f.deliveryId });
    expect(v.delivery).toMatchObject({ state: 'FIXING', currentHeadSha: 'P2' });
    expect(v.attempts[0].reportedShas).toEqual(['P1', 'P2']);
    const w = await seedWorker(f.fix.id, { status: 'completed', lastCommitSha: 'P2', commitCount: 2 });
    await seam.attemptEnded({ task: f.fix, workerId: w, status: 'completed', localHeadSha: 'P2', commitCount: 2, source: 'runner' }, deps);
    v = await loadView({ deliveryId: f.deliveryId });
    expect(v.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'P2', currentRound: 2 });
    const [row] = await q<{ pushed_head_sha: string; outcome: string }>(sql`SELECT pushed_head_sha, outcome FROM workflow_attempts WHERE id = ${v.attempts[0].id}::uuid`);
    expect(row).toEqual({ pushed_head_sha: 'P2', outcome: 'delivered' });
  });

  test('S23 (review family): a person pushing while a fix is only queued consumes no ledger row', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'request-changes');
    await push(o, 'HUMAN1');
    const v = await loadView({ deliveryId: o.deliveryId });
    expect(v.attempts.map((a) => [a.attemptNo, a.status])).toEqual([[1, 'cancelled']]);
    expect(attemptView(v.attempts, 'review_fix')).toEqual({ n: 1, m: 3 });
    expect(v.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'HUMAN1' });
  });

  // Intended: worker pushes under the owner's git identity and under the bot identity are both
  // attributed to the CI attempt by SHA set (reported_shas) and consume one `ci` ledger row each; a
  // person's push is `foreign_push` and consumes none; the cap bounds dispatches in all three; manual
  // "Fix CI" (retry-ci route) is trigger=human with the configured maxCiRetries and BudgetExtended past it.
  test('S23 (CI): pushes are attributed by SHA set, never author: a reported SHA and an unreported descendant both deliver; each consumed one row', async () => {
    const o = await openAndHandOn();
    const t1 = await ciRepairing(o);
    expect(t1).toMatchObject({ deliveryRole: 'ci_fix' });
    expect((await taskRow(t1.id)).title).toContain('after CI #1');
    // The runner reported its local head (metric sync) before pushing it.
    await seam.recordLocalHead(t1.id, 'C1');
    expect((await ciAttempts(o.deliveryId))[0].reportedShas).toEqual(['C1']);
    await push(o, 'C1', { ancestors: ['H1'] });
    let v = await loadView({ deliveryId: o.deliveryId });
    expect(v.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'C1', currentRound: 2 });
    expect(v.attempts.find((a) => a.family === 'ci')).toMatchObject({ outcome: 'delivered' });
    // While that worker still runs (it watches the checks), a red C1 is its to fix: no second row.
    expect((await ciFail(o) as { result: { reason: string } }).result.reason).toBe('fix_in_flight');
    expect((await endCi(t1, 'completed', { local: 'C1', commits: 1 })).result).toMatchObject({ result: 'stale' });
    expect((await ciAttempts(o.deliveryId))[0]).toMatchObject({ status: 'ended', outcome: 'delivered' });

    // CI red again; this push was never reported by the runner (a bot-identity commit): it descends from the bound head.
    const t2 = await ciRepairing(o);
    await push(o, 'C2', { ancestors: ['C1', 'H1'] });
    v = await loadView({ deliveryId: o.deliveryId });
    expect(v.delivery).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'C2' });
    const rows = v.attempts.filter((a) => a.family === 'ci');
    expect(rows.map((a) => [a.attemptNo, a.outcome])).toEqual([[1, 'delivered'], [2, 'delivered']]);
    const [r1, r2] = await q<{ pushed_head_sha: string }>(sql`SELECT pushed_head_sha FROM workflow_attempts WHERE delivery_id = ${o.deliveryId}::uuid AND family = 'ci' ORDER BY attempt_no`);
    expect([r1.pushed_head_sha, r2.pushed_head_sha]).toEqual(['C1', 'C2']);
    expect((await taskRow(t2.id)).title).toContain('after CI #2');
    // The completed worker ends its (already delivered) row without moving the delivery.
    expect((await endCi(t2, 'completed', { local: 'C2', commits: 1 })).result).toMatchObject({ result: 'stale' });
    expect((await ciAttempts(o.deliveryId))[1]).toMatchObject({ status: 'ended', outcome: 'delivered' });
  });

  test('S23 (CI): a person pushing while the CI fix is only queued consumes no row; the queued task is cancelled', async () => {
    const o = await openAndHandOn();
    const seen = await ciFail(o);
    const taskId = (seen as { attemptTaskId: string }).attemptTaskId;
    await push(o, 'HUMAN1', { ancestors: ['H1'] });
    const rows = await ciAttempts(o.deliveryId);
    expect(rows.map((a) => [a.attemptNo, a.status])).toEqual([[1, 'skipped']]);
    expect(attemptView(rows, 'ci')).toEqual({ n: 0, m: 3 });
    expect((await taskRow(taskId)).status).toBe('cancelled');
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'HUMAN1', currentRound: 2 });
  });

  test('S23 (CI): the cap bounds dispatches; an old-SHA failure is recorded only; manual Fix CI past the cap is a BudgetExtended attempt', async () => {
    const o = await openAndHandOn();
    const max = 2;
    const t1 = await ciRepairing(o, max);
    await endCi(t1, 'failed');
    const [, second] = await tasksOf(o.deliveryId, 'ci_fix');
    const t2 = (await taskRow(second.id)).task;
    expect(await seam.claimFix(t2, deps)).toEqual({ action: 'proceed' });
    await endCi(t2, 'failed');
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'ci_exhausted' });
    expect(ciEscalations.length).toBe(1);
    // The sweep coming back changes nothing.
    expect((await ciFail(o, { max }) as { result: { result: string } }).result.result).toBe('stale');
    expect(await seam.observeCiFailure({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, headSha: 'H0', signature: 'ci_failed', maxAttempts: max, source: 'webhook:check_suite' }, deps))
      .toMatchObject({ handled: true, result: { result: 'stale', reason: 'head_not_current' } });
    expect((await tasksOf(o.deliveryId, 'ci_fix')).length).toBe(2);

    const manual = await seam.requestCiRetry({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, actor: 'human:owner', maxAttempts: max, reason: 'flaky runner' }, deps);
    expect(manual).toMatchObject({ handled: true, extended: true, result: { result: 'applied' } });
    const t = (await transitions(o.deliveryId)).at(-1)!;
    expect(t.command).toBe('BudgetExtended');
    const rows = await ciAttempts(o.deliveryId);
    expect(rows.at(-1)).toMatchObject({ attemptNo: 3, trigger: 'human', maxAttempts: 3 });
    const tasks3 = await tasksOf(o.deliveryId, 'ci_fix');
    expect(tasks3.length).toBe(3);
    expect(tasks3[2]).toMatchObject({ creation_source: 'dashboard' });
    expect(tasks3[2].title).toContain('after CI #3');
    // A second click while that attempt is open stacks nothing.
    expect(await seam.requestCiRetry({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, actor: 'human:owner', maxAttempts: max, reason: 'again' }, deps))
      .toMatchObject({ handled: true, result: { result: 'rejected', reason: 'fix_in_flight' } });
  });
});

describe('S24–S27', () => {
  // ── S24: the trunk circuit breaker (§6.10, T25/T26, AC-15) ──
  const incidentsOf = (signature: string) => q<{ id: string; status: string; signature: string; trunk_fix_task_id: string | null; affected_deliveries: string[] }>(
    sql`SELECT id, status, signature, trunk_fix_task_id, affected_deliveries FROM trunk_incidents WHERE workspace_id = ${workspaceId}::uuid AND signature = ${signature} ORDER BY first_seen_at`);
  const trunkFixTasks = (incidentId: string) => q<{ id: string; status: string; title: string }>(sql`SELECT id, status, title FROM tasks WHERE context->>'trunkIncidentId' = ${incidentId}`);

  test('S24: one signature red on trunk and on several PRs → one incident, one trunk fix, zero per-PR attempts (queued ones skipped), BLOCKED_ON_TRUNK; recovery resumes with the ci budget untouched', async () => {
    gh.baseHead = 'B0'; gh.checks = { B0: [], H1: ['Unit tests'] };
    // c went red while the base was still green: an ordinary per-PR CI attempt is queued (its task pending).
    const c = await openAndHandOn();
    expect(await ciFail(c)).toMatchObject({ handled: true, result: { result: 'applied', decision: { toState: 'REPAIRING' } } });
    const [cTask] = await tasksOf(c.deliveryId, 'ci_fix');
    expect((await ciAttempts(c.deliveryId))[0]).toMatchObject({ status: 'queued', triggerReason: 'ci:unit tests' });

    // The base breaks on the same check: the next red PR opens the incident; c joins it.
    gh.baseHead = 'B1'; gh.checks.B1 = ['Unit tests', 'Lint'];
    const a = await openAndHandOn();
    const b = await openAndHandOn();
    expect(await ciFail(a)).toMatchObject({ handled: true, result: { result: 'applied', decision: { toState: 'BLOCKED_ON_TRUNK' } } });
    expect(await ciFail(b)).toMatchObject({ handled: true, result: { result: 'applied', decision: { toState: 'BLOCKED_ON_TRUNK' } } });
    // The sweep coming back for a blocked PR files nothing.
    expect(await ciFail(a)).toMatchObject({ handled: true, result: { result: 'stale' } });

    const [inc] = await incidentsOf('ci:lint|unit tests');
    expect(inc).toMatchObject({ status: 'fixing', trunk_fix_task_id: inc.id });
    expect([...inc.affected_deliveries].sort()).toEqual([a.deliveryId, b.deliveryId, c.deliveryId].sort());
    expect(await trunkFixTasks(inc.id)).toHaveLength(1);
    for (const o of [a, b, c]) {
      expect(await delivery(o.deliveryId)).toMatchObject({ state: 'BLOCKED_ON_TRUNK', trunkIncidentId: inc.id, resumeState: 'AWAITING_REVIEW', boundAttemptId: null });
      expect((await ciAttempts(o.deliveryId)).filter((x) => x.status !== 'skipped')).toEqual([]);
    }
    expect((await ciAttempts(c.deliveryId)).map((x) => x.status)).toEqual(['skipped']);
    expect((await taskRow(cTask.id)).status).toBe('cancelled');
    expect(await tasksOf(a.deliveryId, 'ci_fix')).toEqual([]);
    expect(await tasksOf(b.deliveryId, 'ci_fix')).toEqual([]);

    // Still running on the base: never read as recovered.
    gh.baseHead = 'B2'; gh.checks.B2 = []; gh.running = ['B2'];
    await seam.reconcileTrunkIncidents(deps);
    expect((await incidentsOf('ci:lint|unit tests'))[0].status).toBe('fixing');

    // The base is green: the incident resolves and every blocked PR resumes; its head predates the fix → a mechanical refresh.
    gh.running = [];
    const refreshed: string[] = [];
    override.refresh_branch = async (e) => { refreshed.push(e.deliveryId); return { outcome: 'ok' }; };
    await seam.reconcileTrunkIncidents(deps);
    expect((await incidentsOf('ci:lint|unit tests'))[0].status).toBe('resolved');
    for (const o of [a, b, c]) {
      expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', trunkIncidentId: null, resumeState: null, currentRound: 1 });
      expect(attemptView(await ciAttempts(o.deliveryId), 'ci')).toEqual({ n: 0, m: 3 });
    }
    const mine = [a.deliveryId, b.deliveryId, c.deliveryId];
    expect(refreshed.filter((id) => mine.includes(id)).sort()).toEqual([...mine].sort());
    expect(await trunkFixTasks(inc.id)).toHaveLength(1);
    // A replayed sweep changes nothing.
    const n = (await transitions(a.deliveryId)).length;
    await seam.reconcileTrunkIncidents(deps);
    expect((await transitions(a.deliveryId)).length).toBe(n);
    // A PR whose own failure is not the base's still gets its own attempt.
    gh.checks.H1 = ['Unit tests', 'Typecheck'];
    expect(await ciFail(a)).toMatchObject({ handled: true, result: { result: 'applied', decision: { toState: 'REPAIRING' } } });
  });

  test('S24: two dependency-bot PRs on a red trunk accumulate no retries, however often CI reports', async () => {
    gh.baseHead = 'BD'; gh.checks = { BD: ['Build'], H1: ['Build'] };
    const bots = [await openAndHandOn(), await openAndHandOn()];
    for (const o of bots) {
      await q(sql`UPDATE tasks SET context = jsonb_build_object('adoptedPr', jsonb_build_object('author', 'renovate[bot]', 'authorType', 'Bot')) WHERE id = ${o.ownerTaskId}::uuid`);
      for (let i = 0; i < 3; i++) await ciFail(o);
      expect(await delivery(o.deliveryId)).toMatchObject({ state: 'BLOCKED_ON_TRUNK' });
      expect(await ciAttempts(o.deliveryId)).toEqual([]);
      expect(await tasksOf(o.deliveryId, 'ci_fix')).toEqual([]);
    }
    const incs = await incidentsOf('ci:build');
    expect(incs.filter((i) => i.status !== 'resolved')).toHaveLength(1);
    expect(await trunkFixTasks(incs.at(-1)!.id)).toHaveLength(1);
  });

  test('S24 (opt-in): enough deliveries on one signature inside the window open an incident with no base read; the earlier one joins it', async () => {
    const optIn = { ...deps, repoFor: async () => ({ installationId: 1, repoFullName: REPO, gitConfig: { trunkBreaker: { minDeliveries: 2, windowMinutes: 30 } } }) };
    gh.baseHead = null; gh.checks = { H1: ['Smoke tests'] };
    const first = await openAndHandOn();
    expect(await ciFail(first, { d: optIn })).toMatchObject({ result: { result: 'applied', decision: { toState: 'REPAIRING' } } });
    const second = await openAndHandOn();
    expect(await ciFail(second, { d: optIn })).toMatchObject({ result: { result: 'applied', decision: { toState: 'BLOCKED_ON_TRUNK' } } });
    const [inc] = (await incidentsOf('ci:smoke tests')).filter((i) => i.status !== 'resolved');
    expect((await delivery(first.deliveryId)).state).toBe('BLOCKED_ON_TRUNK');
    expect((await ciAttempts(first.deliveryId)).map((x) => x.status)).toEqual(['skipped']);
    expect(await trunkFixTasks(inc.id)).toHaveLength(1);
    // Off by default: the same two failures without the opt-in stay per-PR.
    gh.checks = { H1: ['Nightly smoke'] };
    const x = await openAndHandOn();
    const y = await openAndHandOn();
    await ciFail(x); await ciFail(y);
    expect((await delivery(y.deliveryId)).state).toBe('REPAIRING');
    expect(await incidentsOf('ci:nightly smoke')).toEqual([]);
  });

  // The base-red rule is on by default; a workspace turns the whole breaker off with
  // gitConfig.trunkBreaker = false. Off: a PR failing the same checks as its red base is an
  // ordinary per-PR CI repair, and no incident or trunk fix exists.
  test('S24 (off): with gitConfig.trunkBreaker = false, a red base failing the same checks opens no incident; each PR gets its own CI attempt', async () => {
    const off = { ...deps, repoFor: async () => ({ installationId: 1, repoFullName: REPO, gitConfig: { trunkBreaker: false } }) };
    gh.baseHead = 'BX'; gh.checks = { BX: ['Integration'], H1: ['Integration'] };
    const o = await openAndHandOn();
    expect(await ciFail(o, { d: off })).toMatchObject({ handled: true, result: { result: 'applied', decision: { toState: 'REPAIRING' } } });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'REPAIRING', trunkIncidentId: null });
    expect((await ciAttempts(o.deliveryId)).map((x) => [x.status, x.triggerReason])).toEqual([['queued', 'ci:integration']]);
    expect(await tasksOf(o.deliveryId, 'ci_fix')).toHaveLength(1);
    expect(await incidentsOf('ci:integration')).toEqual([]);
    // The same failure with the default config is the base's: the breaker is on unless turned off.
    const p2 = await openAndHandOn();
    expect(await ciFail(p2)).toMatchObject({ handled: true, result: { result: 'applied', decision: { toState: 'BLOCKED_ON_TRUNK' } } });
    expect(await incidentsOf('ci:integration')).toHaveLength(1);
  });

  test('S25: a fix whose head moved between the verdict and the dispatch is skipped at dispatch: no ledger row, no task; replay is a no-op', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'request-changes', 'H1', crashedDeps);
    gh.head = 'H9'; // pushed; the webhook has not arrived
    await drain(o.deliveryId);
    const [df] = await effects(o.deliveryId, 'dispatch_fix');
    expect(df).toMatchObject({ status: 'done', outcome: 'skipped:fix_not_needed' });
    expect((await loadView({ deliveryId: o.deliveryId })).attempts).toEqual([]);
    expect(await tasksOf(o.deliveryId, 'fix')).toEqual([]);
    await q(sql`UPDATE workflow_effects SET status = 'pending', not_before = now() WHERE id = ${df.id}::uuid`);
    await drain(o.deliveryId);
    expect((await loadView({ deliveryId: o.deliveryId })).attempts).toEqual([]);
    expect(await tasksOf(o.deliveryId, 'fix')).toEqual([]);
  });

  test('S25: a fix whose target moved between dispatch and claim (head moved, or merged) is skipped at claim, cancelled not failed', async () => {
    const a = await openAndHandOn();
    await verdict(a, 'request-changes');
    const [fixA] = await tasksOf(a.deliveryId, 'fix');
    gh.head = 'H9';
    const decision = await seam.claimFix((await taskRow(fixA.id)).task, deps);
    expect(decision).toEqual({ action: 'cancel', reason: 'fix_not_needed' });
    await seam.cancelSkippedTask(fixA.id, decision.action === 'cancel' ? decision.reason : '');
    expect((await loadView({ deliveryId: a.deliveryId })).attempts[0]).toMatchObject({ status: 'skipped', outcome: 'noop' });
    expect(await taskRow(fixA.id)).toMatchObject({ status: 'cancelled', result: { skipped: true, skipReason: 'fix_not_needed' } });

    gh = { head: 'H1', state: 'open', merged: false, updatedAt: 'u0', ancestors: {} };
    const b = await openAndHandOn();
    await verdict(b, 'request-changes');
    const [fixB] = await tasksOf(b.deliveryId, 'fix');
    await closeOrMerge(b, true);
    expect(await seam.claimFix((await taskRow(fixB.id)).task, deps)).toMatchObject({ action: 'cancel' });
    expect((await delivery(b.deliveryId)).state).toBe('MERGED');
  });

  // Intended: the S25 skip for the other families — CI green on the current head, conflict resolved
  // meanwhile — at dispatch and at claim (conflict-retry, ci-failure-retry).
  test('S25 (CI): CI green at dispatch skips the row, files no task and resumes review; replay is a no-op', async () => {
    const o = await openAndHandOn();
    await ciFail(o, { d: crashedDeps });
    gh.ciGreen = true; // the re-run passed before the dispatch effect ran
    await drain(o.deliveryId);
    const [df] = await effects(o.deliveryId, 'dispatch_ci_fix');
    expect(df).toMatchObject({ status: 'done', outcome: 'skipped:ci_green' });
    expect((await ciAttempts(o.deliveryId)).map((a) => a.status)).toEqual(['skipped']);
    expect(await tasksOf(o.deliveryId, 'ci_fix')).toEqual([]);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', ci: 'green', currentRound: 1 });
    await q(sql`UPDATE workflow_effects SET status = 'pending', not_before = now() WHERE id = ${df.id}::uuid`);
    await drain(o.deliveryId);
    expect(await tasksOf(o.deliveryId, 'ci_fix')).toEqual([]);
    expect((await ciAttempts(o.deliveryId)).length).toBe(1);
  });

  test('S25 (CI): green between dispatch and claim cancels the task as skipped, not failed; a moved head skips at dispatch', async () => {
    const a = await openAndHandOn();
    const seen = await ciFail(a);
    const t = (await taskRow((seen as { attemptTaskId: string }).attemptTaskId)).task;
    gh.ciGreen = true;
    const decision = await seam.claimFix(t, deps);
    expect(decision).toEqual({ action: 'cancel', reason: 'ci_green' });
    await seam.cancelSkippedTask(t.id, 'ci_green');
    expect(await taskRow(t.id)).toMatchObject({ status: 'cancelled', result: { skipped: true, skipReason: 'ci_green' } });
    expect((await ciAttempts(a.deliveryId))[0]).toMatchObject({ status: 'skipped', outcome: 'noop' });
    expect((await delivery(a.deliveryId)).state).toBe('AWAITING_REVIEW');

    gh = { head: 'H1', state: 'open', merged: false, updatedAt: 'u0', ancestors: {} };
    const b = await openAndHandOn();
    await ciFail(b, { d: crashedDeps });
    gh.head = 'H9'; gh.ancestors.H9 = ['H1']; // pushed; the webhook has not arrived
    await drain(b.deliveryId);
    expect((await effects(b.deliveryId, 'dispatch_ci_fix'))[0]).toMatchObject({ outcome: 'skipped:head_moved' });
    expect((await ciAttempts(b.deliveryId)).map((x) => x.status)).toEqual(['skipped']);
    expect(await tasksOf(b.deliveryId, 'ci_fix')).toEqual([]);
    expect(await delivery(b.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H9', currentRound: 2 });
  });

  // Intended: the same skip for the conflict family (conflict resolved meanwhile) at dispatch and at
  // claim, once conflict-retry dispatches through T12 (§6.7).
  test('S25 (conflict): resolved between the mechanical refusal and the agent dispatch → the agent row is skipped, no task; replay is a no-op', async () => {
    const o = await openAndHandOn();
    gh.mergeable = 'dirty';
    // update-branch refuses with a textual conflict; by the time the agent is dispatched it is gone.
    updateBranch({ conflict: true, thenMergeable: 'clean' });
    await conflictDoor(o);
    const rows = await repairAttempts(o.deliveryId);
    expect(rows.map((a) => [a.mode, a.status, a.outcome])).toEqual([['mechanical', 'ended', 'failed'], ['agent', 'skipped', 'noop']]);
    expect(await conflictTasks(o.deliveryId)).toEqual([]);
    const [df] = await effects(o.deliveryId, 'dispatch_conflict_fix');
    expect(df).toMatchObject({ status: 'done', outcome: 'skipped:conflict_resolved' });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', mergeable: 'clean', currentRound: 1 });
    await q(sql`UPDATE workflow_effects SET status = 'pending', not_before = now() WHERE id = ${df.id}::uuid`);
    await drain(o.deliveryId);
    expect(await conflictTasks(o.deliveryId)).toEqual([]);
    expect((await repairAttempts(o.deliveryId)).length).toBe(2);
  });

  test('S25 (conflict): resolved between dispatch and claim → the task is cancelled as skipped, not failed, and the delivery resumes', async () => {
    const o = await openAndHandOn();
    gh.mergeable = 'dirty';
    updateBranch({ conflict: true });
    const res = await conflictDoor(o);
    expect(res).toMatchObject({ dispatched: true });
    const [cf] = await conflictTasks(o.deliveryId);
    expect(res.taskId).toBe(cf.id);
    gh.mergeable = 'clean'; // someone merged the base in by hand; the head did not move
    const t = (await taskRow(cf.id)).task;
    const decision = await seam.claimFix(t, deps);
    expect(decision).toEqual({ action: 'cancel', reason: 'conflict_resolved' });
    await seam.cancelSkippedTask(cf.id, 'conflict_resolved');
    expect(await taskRow(cf.id)).toMatchObject({ status: 'cancelled', result: { skipped: true, skipReason: 'conflict_resolved' } });
    expect((await repairAttempts(o.deliveryId)).at(-1)).toMatchObject({ mode: 'agent', status: 'skipped', outcome: 'noop' });
    expect((await delivery(o.deliveryId)).state).toBe('AWAITING_REVIEW');
  });

  test('S26: the activity comment is regenerated from transitions: one comment, equal to a fresh render, Merged stays the headline', async () => {
    const { renderDeliveryActivity } = await import('../../src/lib/workflow/pr-activity-render');
    const { renderActivityEffect } = await import('../../src/lib/workflow/pr-activity-effects');
    const f = await fixing();
    // A sticky comment written before the kernel took over, and a duplicate of it.
    comments.set(commentSeq++, `${realActivity.ACTIVITY_COMMENT_MARKER}\n**buildd** · **Reviewing**`);
    comments.set(commentSeq++, `${realActivity.ACTIVITY_COMMENT_MARKER}\n**buildd** · **Reviewing**`);
    const workerId = await seedWorker(f.fix.id, { status: 'completed', lastCommitSha: 'H2', commitCount: 1 });
    gh.head = 'H2'; gh.ancestors.H2 = ['H1'];
    await seam.attemptEnded({ task: f.fix, workerId, status: 'completed', localHeadSha: 'H2', commitCount: 1, source: 'runner' }, deps);
    await verdict(f, 'approve', 'H2');
    await closeOrMerge(f, true);
    // A late legacy write after the merge (a `reviewing` row racing it) is diverted, not appended.
    await q(sql`INSERT INTO workflow_facts (delivery_id, workspace_id, repo_full_name, pr_number, kind, fact_key, source, payload)
      VALUES (${f.deliveryId}::uuid, ${workspaceId}::uuid, ${REPO}, ${f.prNumber}, 'activity_note', ${`activity:${f.deliveryId}:late`}, 'test',
        ${JSON.stringify({ kind: 'reviewing', at: new Date(Date.now() + 60_000).toISOString() })}::jsonb)`);
    await makeDue(f.deliveryId);
    await drain(f.deliveryId);

    const renders = await effects(f.deliveryId, 'render_activity');
    expect(renders.length).toBeGreaterThan(0);
    expect(renders.every((e) => e.status === 'done')).toBe(true);
    expect(comments.size).toBe(1);
    const [body] = [...comments.values()];
    expect(body.split('\n')[1]).toContain('**Merged**');

    // The comment equals a fresh render of canonical state.
    const view = await loadView({ deliveryId: f.deliveryId });
    const log = (await q<{ command: string; from_state: string | null; to_state: string; to_version: number; evidence: Record<string, unknown>; created_at: string }>(
      sql`SELECT command, from_state, to_state, to_version, evidence, created_at FROM workflow_transitions WHERE delivery_id = ${f.deliveryId}::uuid ORDER BY to_version`))
      .map((t) => ({ command: t.command, fromState: t.from_state, toState: t.to_state, toVersion: Number(t.to_version), evidence: t.evidence, createdAt: new Date(t.created_at).toISOString() }));
    const notes = (await q<{ payload: never; observed_at: string }>(sql`SELECT payload, observed_at FROM workflow_facts WHERE delivery_id = ${f.deliveryId}::uuid AND kind = 'activity_note'`))
      .map((n) => ({ entry: n.payload, observedAt: new Date(n.observed_at).toISOString() }));
    expect(body).toBe(renderDeliveryActivity({ view, transitions: log, notes, timezone: 'UTC' }));
    expect(body).toContain('Changes requested');
    expect(body).toContain('Pushed `H2`');
    expect(body).not.toContain('Reviewing');

    // Replaying a render is convergent: nothing changes, still one comment.
    const last = (await effects(f.deliveryId, 'render_activity')).at(-1)!;
    const replay = await renderActivityEffect({ id: last.id, deliveryId: f.deliveryId, transitionId: last.transition_id, kind: 'render_activity', dedupeKey: last.dedupe_key, payload: {}, attemptCount: 1, delivery: null, transition: null },
      { github: fakeGithubApi as never, repoFor, timezone: async () => 'UTC' });
    expect(replay.outcome).toBe('ok:unchanged');
    expect(comments.size).toBe(1);
  });

  test('S26: "Approved" never heads a delivery whose current head went to REPAIRING', async () => {
    const { renderDeliveryActivity } = await import('../../src/lib/workflow/pr-activity-render');
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    const view = await loadView({ deliveryId: o.deliveryId });
    const repairing = { ...view, delivery: { ...view.delivery!, state: 'REPAIRING' as const, stateReason: 'ci' } };
    expect(renderDeliveryActivity({ view: repairing, transitions: [], timezone: 'UTC' }).split('\n')[1]).not.toContain('Approved');
  });

  // Intended: behind-only conflict and a byte-identical migration renumber complete as mechanical
  // attempts with no task; a textual conflict and a non-identical renumber escalate to an agent
  // attempt; a lagging mission branch is not a collision; dependency-bot PRs are never pushed to.
  test('S27: a behind-only branch is brought up to date mechanically: no task, no agent budget spent', async () => {
    const o = await openAndHandOn();
    gh.mergeable = 'behind';
    updateBranch({ merged: 'R1' });
    expect(await conflictDoor(o, { behindOnly: true })).toMatchObject({ dispatched: true, branchUpdated: true });
    expect(await conflictTasks(o.deliveryId)).toEqual([]);
    expect((await repairAttempts(o.deliveryId)).map((a) => [a.family, a.mode, a.outcome])).toEqual([['conflict', 'mechanical', 'delivered']]);
    // Unapproved: the refreshed head is reviewed (a delta round), it never borrows a verdict.
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'R1', currentRound: 2 });
  });

  test('S27: a textual conflict escalates to exactly one agent attempt; a second door finds it in flight', async () => {
    const o = await openAndHandOn();
    gh.mergeable = 'dirty';
    updateBranch({ conflict: true });
    const first = await conflictDoor(o);
    const [cf] = await conflictTasks(o.deliveryId);
    expect(first).toMatchObject({ dispatched: true, taskId: cf.id });
    expect(cf).toMatchObject({ creation_source: 'conflict', context: { workflowAttemptId: cf.id } });
    expect(cf.title).toContain('after conflict #1');
    expect((await repairAttempts(o.deliveryId)).map((a) => [a.mode, a.attemptNo, a.status, a.outcome])).toEqual([['mechanical', 1, 'ended', 'failed'], ['agent', 1, 'queued', null]]);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'REPAIRING', stateReason: 'conflict' });
    // The legacy counter never moved: the ledger is the budget.
    expect((await taskRow(o.ownerTaskId)).context?.conflictIteration ?? null).toBeNull();
    expect(await conflictDoor(o)).toMatchObject({ dispatched: false, inFlightTaskId: cf.id });
    expect((await conflictTasks(o.deliveryId)).length).toBe(1);
  });

  test('S27: a byte-identical migration renumber is a mechanical rename (same blob, next free slot past base, trunk and the peer); no task', async () => {
    const o = await openAndHandOn();
    const collision = migrationRepo(o, { journal: false });
    expect(await conflictDoor(o, { migrationCollision: collision })).toMatchObject({ dispatched: true, branchUpdated: true });
    const tree = ghWrites.find((w) => w.path.endsWith('/git/trees'))!;
    expect(tree.body).toMatchObject({ base_tree: 'TREE0', tree: [
      { path: 'packages/core/drizzle/0008_add.sql', sha: 'BLOB7' },
      { path: 'packages/core/drizzle/0007_add.sql', sha: null },
    ] });
    expect(ghWrites.find((w) => /\/git\/refs\/heads\/feat\/matrix$/.test(w.path))!.body).toEqual({ sha: 'N1', force: false });
    expect(await conflictTasks(o.deliveryId)).toEqual([]);
    expect((await repairAttempts(o.deliveryId)).map((a) => [a.family, a.mode, a.status, a.outcome])).toEqual([['migration', 'mechanical', 'ended', 'delivered']]);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'N1' });
  });

  test('S27: a renumber that must be regenerated (drizzle journal) escalates to an agent attempt with the renumber recipe', async () => {
    const o = await openAndHandOn();
    const collision = migrationRepo(o, { journal: true });
    expect(await conflictDoor(o, { migrationCollision: collision })).toMatchObject({ dispatched: true });
    const [cf] = await conflictTasks(o.deliveryId);
    expect(cf.title).toContain('migration collision');
    expect((await repairAttempts(o.deliveryId)).map((a) => [a.family, a.mode, a.status])).toEqual([['migration', 'mechanical', 'ended'], ['migration', 'agent', 'queued']]);
    expect(ghWrites.some((w) => w.path.endsWith('/git/trees'))).toBe(false);
  });

  test('S27: a "collision" with a PR into another base (a mission branch lagging trunk) is not a collision: nothing renumbered, nothing filed', async () => {
    const o = await openAndHandOn();
    const collision = migrationRepo(o, { journal: false, ourBase: 'mission/m1', peerBase: 'dev' });
    expect(await conflictDoor(o, { migrationCollision: collision })).toMatchObject({ dispatched: false, alreadyUpToDate: true });
    expect(ghWrites).toEqual([]);
    expect(await conflictTasks(o.deliveryId)).toEqual([]);
    expect((await repairAttempts(o.deliveryId)).map((a) => [a.mode, a.status])).toEqual([['mechanical', 'skipped']]);
    expect((await delivery(o.deliveryId)).state).toBe('AWAITING_REVIEW');
  });

  test('S27: a dependency-bot PR is never pushed to: no update-branch, no task', async () => {
    const o = await openAndHandOn();
    await q(sql`UPDATE tasks SET context = jsonb_build_object('adoptedPr', jsonb_build_object('author', 'renovate[bot]', 'authorType', 'Bot')) WHERE id = ${o.ownerTaskId}::uuid`);
    gh.mergeable = 'behind';
    updateBranch({ merged: 'R1' });
    expect(await conflictDoor(o, { behindOnly: true })).toMatchObject({ dispatched: false, dependencyBot: true });
    expect(ghWrites).toEqual([]);
    expect(await repairAttempts(o.deliveryId)).toEqual([]);
  });

  // The landing door reaches refresh_branch through T16, past the conflict doors' own dependency-bot
  // check: the handler refuses to push there too, and a person lands it.
  test('S27 (doors): a dependency-bot PR whose merge is answered behind is never pushed to: no update-branch, no task, a person lands it', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    await q(sql`UPDATE tasks SET context = jsonb_build_object('adoptedPr', jsonb_build_object('author', 'renovate[bot]', 'authorType', 'Bot')) WHERE id = ${o.ownerTaskId}::uuid`);
    mergeAnswer = () => ({ merged: false, message: 'Head branch is out of date' });
    await seam.landThroughKernel({ workspaceId, installationId: 1, repoFullName: REPO, prNumber: o.prNumber, headSha: 'H1', door: 'auto_merge', actor: 'system:auto_merge' }, deps);
    expect(updateBranchCalls).toEqual([]);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'landing_needs_human' });
    expect((await repairAttempts(o.deliveryId)).map((a) => [a.mode, a.status, a.outcome])).toEqual([['mechanical', 'ended', 'failed']]);
    expect(await conflictTasks(o.deliveryId)).toEqual([]);
  });
});

describe('S28 — ledger separation', () => {
  test('S28 (review family): review rounds allocate no ledger rows; review_fix attempts are 1-based and the fix task shows the same N of M', async () => {
    const o = await openAndHandOn();
    expect((await loadView({ deliveryId: o.deliveryId })).attempts).toEqual([]);
    await verdict(o, 'request-changes');
    const v = await loadView({ deliveryId: o.deliveryId });
    expect(v.attempts.map((a) => [a.family, a.mode, a.attemptNo])).toEqual([['review_fix', 'agent', 1]]);
    const view = attemptView(v.attempts, 'review_fix');
    expect(view).toEqual({ n: 1, m: 3 });
    const [fix] = await tasksOf(o.deliveryId, 'fix');
    expect(fix.context).toMatchObject({ iteration: view.n, maxIterations: view.m });
    expect(attemptView(v.attempts, 'ci')).toEqual({ n: 0, m: 3 });
  });

  // Intended: CI, review, conflict, migration and trunk families count independently on one
  // delivery; a reviewer spawned on a CI-fix task does not inherit the CI count; infra requeues
  // change no ledger; attemptView is identical in the activity comment, the task title and explain.
  test('S28: CI and review families count independently on one delivery; a re-claim (infra requeue) adds no row; comment and title show the same N of M', async () => {
    const o = await openAndHandOn();
    const t = await ciRepairing(o);
    // An infra requeue re-claims the same task: same row, still running, no new attempt.
    expect(await seam.claimFix(t, deps)).toEqual({ action: 'proceed' });
    expect((await ciAttempts(o.deliveryId)).length).toBe(1);
    await seam.recordLocalHead(t.id, 'C1');
    await push(o, 'C1', { ancestors: ['H1'] });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2 });
    // Round 2's reviewer requests changes: the review fix is attempt 1, not 2.
    expect(await verdict(o, 'request-changes')).toMatchObject({ toState: 'CHANGES_REQUESTED' });
    const v = await loadView({ deliveryId: o.deliveryId });
    expect(v.attempts.map((a) => [a.family, a.attemptNo]).sort()).toEqual([['ci', 1], ['review_fix', 1]]);
    expect(attemptView(v.attempts, 'ci')).toEqual({ n: 1, m: 3 });
    expect(attemptView(v.attempts, 'review_fix')).toEqual({ n: 1, m: 3 });
    const [fix] = await tasksOf(o.deliveryId, 'fix');
    expect(fix.context).toMatchObject({ iteration: 1, maxIterations: 3 });
    const [ciTask] = await tasksOf(o.deliveryId, 'ci_fix');
    expect(ciTask.context).toMatchObject({ iteration: 1, maxIterations: 3 });
    expect(ciTask.title).toContain('after CI #1');
    // The reviewer of round 2 was spawned after a CI fix and carries no CI count.
    const reviewer = await reviewerOf(o.deliveryId);
    expect(reviewer.context).not.toHaveProperty('ciRetryPrNumber');
    // The activity comment's CI line reads the same 1-based N of M as the ledger.
    expect(activityEntries.find((e) => e.kind === 'ci_fixing')).toMatchObject({ iteration: 1, maxIterations: 3 });
  });

  // Intended: explain's because[] and the DeliveryView read attemptView, so explain says "CI 1 of 3"
  // exactly as the comment and the title do.
  test('S28: explain renders the same family-labelled attemptView as the ledger, the comment and the title', async () => {
    const o = await openAndHandOn();
    const t = await ciRepairing(o);
    await seam.recordLocalHead(t.id, 'C1');
    await push(o, 'C1', { ancestors: ['H1'] });
    await verdict(o, 'request-changes');
    const v = await loadView({ deliveryId: o.deliveryId });
    const ci = attemptView(v.attempts, 'ci');
    const review = attemptView(v.attempts, 'review_fix');
    const { explainTask } = await import('../../src/lib/explain');
    const res = await explainTask(o.ownerTaskId, {});
    const answer = res!.subjects[0];
    expect(answer.delivery?.attempts).toBe(`CI ${ci.n} of ${ci.m} · review ${review.n} of ${review.m}`);
    expect(answer.delivery).toMatchObject({ state: 'CHANGES_REQUESTED', owner: 'platform', needsYou: false });
    // The same numbers the CI fix task's title and the activity comment carry.
    const [ciTask] = await tasksOf(o.deliveryId, 'ci_fix');
    expect(ciTask.title).toContain(`after CI #${ci.n}`);
    expect(activityEntries.find((e) => e.kind === 'ci_fixing')).toMatchObject({ iteration: ci.n, maxIterations: ci.m });
  });
});

describe('S29 — reviewer ends with prose or no verdict', () => {
  // Final kernel audit (task 708a55c0): a person interrupting a kernel round's reviewer
  // (POST /api/workers/[id]/interrupt) is T27 with human_takeover — no re-queue, no new
  // reviewer: the delivery escalates and the person owns the review.
  test('a human takeover fails the round once → ESCALATED(review_unavailable), no reviewer re-dispatched', async () => {
    const o = await openAndHandOn();
    const r = await reviewerOf(o.deliveryId);
    const before = reviewersCreated.length;
    const w = await seedWorker(r.id, { status: 'failed' });
    await seam.attemptEnded({ task: r, workerId: w, status: 'failed', localHeadSha: null, commitCount: 0, source: 'human:interrupt', reviewFailure: 'human_takeover' }, deps);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_unavailable', currentRound: 1, approvedHeads: [] });
    expect((await rounds(o.deliveryId)).map((x) => [x.round, x.status, x.failure_count])).toEqual([[1, 'failed', 1]]);
    expect((await transitions(o.deliveryId)).at(-1)).toMatchObject({ command: 'ReviewRoundFailed', to_state: 'ESCALATED', evidence: { reason: 'human_takeover' } });
    expect(reviewersCreated.length).toBe(before);
    expect(posted).toEqual([]);
  });

  test('a prose verdict is a round failure recorded as prose_verdict, never an approve, on the same T27 budget (task 7313de90)', async () => {
    const o = await openAndHandOn();
    const r = await reviewerOf(o.deliveryId);
    expect(await seam.isKernelReviewRound(r)).toBe(true);
    const w = await seedWorker(r.id, { status: 'failed' });
    await seam.attemptEnded({ task: r, workerId: w, status: 'failed', localHeadSha: null, commitCount: 0, source: 'runner', reviewFailure: 'prose_verdict' }, deps);
    expect((await rounds(o.deliveryId)).map((x) => [x.round, x.head_sha, x.status, x.failure_count, x.verdict])).toEqual([[1, 'H1', 'queued', 1, null]]);
    const t = (await transitions(o.deliveryId)).at(-1)!;
    expect(t).toMatchObject({ command: 'ReviewRoundFailed', to_state: 'AWAITING_REVIEW', evidence: { reason: 'prose_verdict' } });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', approvedHeads: [] });
    expect(posted).toEqual([]);
    expect(await tasksOf(o.deliveryId, 'fix')).toEqual([]);
    // The kill switch released it: legacy decides the contract failure again.
    await q(sql`UPDATE workflow_deliveries SET authority = 'legacy' WHERE id = ${o.deliveryId}::uuid`);
    expect(await seam.isKernelReviewRound(await reviewerOf(o.deliveryId))).toBe(false);
  });


  test('the round fails and is re-queued at the same head and round number, then ESCALATED(review_unavailable); a late verdict is never applied', async () => {
    const o = await openAndHandOn();
    const failOnce = async () => {
      const r = await reviewerOf(o.deliveryId);
      const w = await seedWorker(r.id, { status: 'failed' });
      return seam.attemptEnded({ task: r, workerId: w, status: 'failed', localHeadSha: null, commitCount: 0, source: 'runner' }, deps);
    };
    for (let n = 1; n <= seam.REVIEW_CONTRACT_RETRIES; n++) {
      await failOnce();
      const rs = await rounds(o.deliveryId);
      expect(rs.map((r) => [r.round, r.head_sha, r.status, r.failure_count])).toEqual([[1, 'H1', 'queued', n]]);
      expect((await delivery(o.deliveryId)).state).toBe('AWAITING_REVIEW');
      expect(reviewersCreated.length).toBe(n + 1);
    }
    const last = await reviewerOf(o.deliveryId);
    await failOnce();
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_unavailable', currentRound: 1 });
    expect((await rounds(o.deliveryId))[0]).toMatchObject({ status: 'failed', verdict: null });

    const late = await seam.recordReviewVerdict({ reviewerTask: last, verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 1 }, deps);
    expect(late).toMatchObject({ handled: true, toState: null });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'ESCALATED', approvedHeads: [] });
    expect(posted).toEqual([]);
  });
});

describe('AWAITING_PUSH — an owner delivery leaves on a push (§6.4, §9)', () => {
  const prUrlOf = (o: Delivery) => `https://github.com/${REPO}/pull/${o.prNumber}`;
  /** The owner's hand-off failed with local commit L5: AWAITING_PUSH at H1. */
  async function ownerAwaitingPush(local: string | null = 'L5', status: 'unproven' | 'lost' = 'unproven') {
    const o = await open();
    const w = await seedWorker(o.ownerTaskId, { status: 'failed', lastCommitSha: local, prNumber: o.prNumber, commitCount: 2 });
    await q(sql`UPDATE workers SET pr_url = ${prUrlOf(o)} WHERE pr_number = ${o.prNumber}::int AND workspace_id = ${workspaceId}::uuid`);
    await seam.attemptEnded({ task: ownerTask(o), workerId: w, status, localHeadSha: local, commitCount: 2, source: status === 'lost' ? 'sweep:stale-workers' : 'runner' }, deps);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_PUSH', currentHeadSha: 'H1', currentRound: 0 });
    return o;
  }

  test('the pushed head (webhook synchronize: the fact funnel plus the kernel hint) proves L5 → AWAITING_REVIEW, round 1 at the new head, review dispatched', async () => {
    const o = await ownerAwaitingPush();
    gh.head = 'L5'; gh.ancestors.L5 = ['H1'];
    // What the synchronize webhook does: the open-state fact to the funnel, the head hint to the kernel.
    await recordPrFact({ prUrl: prUrlOf(o), prNumber: o.prNumber }, { kind: 'open' });
    expect(await push(o, 'L5', { ancestors: ['H1'] })).toBe(true);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'L5', currentRound: 1 });
    expect((await rounds(o.deliveryId)).map((r) => [r.round, r.head_sha, r.status])).toEqual([[1, 'L5', 'queued']]);
    expect(reviewersCreated.map((r) => r.head)).toEqual(['L5']);
  });

  test('a head that does not contain L5 is recorded, the delivery stays, and the next push_recovery is scheduled; the real push then proves it', async () => {
    const o = await ownerAwaitingPush();
    const recoveryBefore = (await effects(o.deliveryId, 'push_recovery')).length;
    await push(o, 'H7', { ancestors: ['H1'] }); // someone else's push: L5 is not in it
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_PUSH', currentHeadSha: 'H7', currentRound: 0 });
    expect(await rounds(o.deliveryId)).toEqual([]);
    expect((await effects(o.deliveryId, 'push_recovery')).length).toBe(recoveryBefore + 1);
    await push(o, 'L5', { ancestors: ['H7', 'H1'] });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'L5', currentRound: 1 });
  });

  test('a push the webhook never delivered is found by push_recovery\'s own re-read and proves the same way', async () => {
    const o = await ownerAwaitingPush();
    gh.head = 'L5'; gh.ancestors.L5 = ['H1'];
    await makeDue(o.deliveryId);
    await drain(o.deliveryId);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'L5', currentRound: 1 });
    expect(reviewersCreated.map((r) => r.head)).toEqual(['L5']);
  });

  // Final kernel audit (task 708a55c0): the waiting-input sweep sent localHeadSha null and
  // commitCount 0, which the reducer reads as "nothing local to lose" and hands the remote head
  // on to review. With what the worker reported (stale-workers.test.ts pins the pass-through),
  // unpushed owner commits wait for their push instead.
  test('the waiting-input sweep ends an owner attempt with unpushed commits → AWAITING_PUSH + push_recovery; no round at the old head', async () => {
    const o = await open();
    const w = await seedWorker(o.ownerTaskId, { status: 'failed', lastCommitSha: 'L5', prNumber: o.prNumber, commitCount: 2 });
    const r = await seam.attemptEnded({ task: ownerTask(o), workerId: w, status: 'lost', localHeadSha: 'L5', commitCount: 2, source: 'sweep:waiting-input' }, deps);
    expect(r.result).toMatchObject({ result: 'applied' });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_PUSH', currentHeadSha: 'H1', currentRound: 0 });
    expect(await rounds(o.deliveryId)).toEqual([]);
    expect(reviewersCreated).toEqual([]);
    expect((await effects(o.deliveryId, 'push_recovery')).length).toBe(1);
  });
});

describe('§11 — the reconciliation floor re-imports what a lost webhook never delivered (ddcbe113)', () => {
  const floor = (o: Delivery) => seam.reconcileKernelDeliveries(deps, { only: [o.deliveryId], minQuietMs: 0 });

  test('a missed synchronize: APPROVED at H1 while GitHub is at H2 → the floor imports the head and a delta round at H2 starts', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'APPROVED', currentHeadSha: 'H1' });
    gh.head = 'H2'; // pushed; the synchronize webhook never arrived
    gh.ancestors.H2 = ['H1'];
    const before = reviewersCreated.length;

    const s = await floor(o);
    expect(s).toMatchObject({ checked: 1, imported: 1, errors: 0 });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H2', currentRound: 2 });
    expect((await rounds(o.deliveryId)).at(-1)).toMatchObject({ round: 2, head_sha: 'H2', kind: 'delta' });
    expect(reviewersCreated.slice(before).map((r) => [r.round, r.head])).toEqual([[2, 'H2']]);
    const t = (await transitions(o.deliveryId)).at(-1)!;
    expect(t.command).toBe('HeadObserved');
    expect(t.evidence.actor).toBe('sweep:kernel-floor');

    // A second pass with nothing new does nothing.
    expect(await floor(o)).toMatchObject({ checked: 1, imported: 0, enqueued: 0 });
    expect(reviewersCreated.length).toBe(before + 1);
  });

  test('a missed closed(merged): the floor reads merged and the delivery is MERGED', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    gh.state = 'closed'; gh.merged = true; gh.updatedAt = 'u-merged';
    expect(await floor(o)).toMatchObject({ imported: 1 });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'MERGED' });
  });

  test('a draft PR\'s push is imported too: the floor reads the live head whatever the draft flag', async () => {
    const o = await openAndHandOn();
    gh.head = 'H2';
    await floor(o);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H2', currentRound: 2 });
  });

  test('CHANGES_REQUESTED with its dispatch_fix lost: the floor re-enqueues it under its own dedupe key and the fix is filed', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'request-changes', 'H1', crashedDeps);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'CHANGES_REQUESTED' });
    const [lost] = await effects(o.deliveryId, 'dispatch_fix');
    await q(sql`DELETE FROM workflow_effects WHERE id = ${lost.id}::uuid`);
    expect(await tasksOf(o.deliveryId, 'fix')).toEqual([]);

    expect(await floor(o)).toMatchObject({ imported: 0, enqueued: 1 });
    const again = await effects(o.deliveryId, 'dispatch_fix');
    expect(again.map((e) => [e.dedupe_key, e.status])).toEqual([[lost.dedupe_key, 'done']]);
    expect((await tasksOf(o.deliveryId, 'fix')).length).toBe(1);
    // Owed and present: nothing more to enqueue.
    expect(await floor(o)).toMatchObject({ enqueued: 0 });
  });

  test('a delivery the kill switch released to legacy is not touched', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    await q(sql`UPDATE workspaces SET git_config = jsonb_set(COALESCE(git_config, '{}'::jsonb), '{workflowKernel}', 'false'::jsonb) WHERE id = ${workspaceId}::uuid`);
    try {
      gh.head = 'H2';
      expect(await floor(o)).toMatchObject({ checked: 0 });
      expect(await delivery(o.deliveryId)).toMatchObject({ state: 'APPROVED', currentHeadSha: 'H1' });
    } finally {
      await q(sql`UPDATE workspaces SET git_config = git_config - 'workflowKernel' WHERE id = ${workspaceId}::uuid`);
    }
  });
});

describe('S30 — runner hand-off failures', () => {
  test('S30 (part 1): an owner attempt reporting completed whose commits are not on GitHub → AWAITING_PUSH, no review round; never a completed delivery', async () => {
    const o = await open();
    const w = await seedWorker(o.ownerTaskId, { status: 'completed', lastCommitSha: 'L9', prNumber: o.prNumber, commitCount: 3 });
    await seam.attemptEnded({ task: ownerTask(o), workerId: w, status: 'completed', localHeadSha: 'L9', commitCount: 3, source: 'runner' }, deps);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_PUSH', currentHeadSha: 'H1', currentRound: 0 });
    expect(await rounds(o.deliveryId)).toEqual([]);
    expect((await effects(o.deliveryId, 'push_recovery')).length).toBe(1);
  });

  // The runner's hand-off failures ("no confirmed outcome", "commits but no PR", "uncommitted
  // changes", output requirement unmet) arrive as `failed` + outcome=unproven with the local head
  // and commit count (apps/runner/src/hand-off-outcome.ts); the worker PATCH maps that onto
  // AttemptEnded(unproven) (lib/workflow/hand-off.ts). Driven here through the seam it calls.
  test('S30: an owner hand-off failure with local commits → AttemptEnded(unproven) → AWAITING_PUSH + push_recovery; replay is a duplicate', async () => {
    const o = await open();
    const w = await seedWorker(o.ownerTaskId, { status: 'failed', lastCommitSha: 'L5', prNumber: o.prNumber, commitCount: 2 });
    const end = () => seam.attemptEnded({ task: ownerTask(o), workerId: w, status: 'unproven', localHeadSha: 'L5', commitCount: 2, source: 'runner' }, deps);
    expect((await end()).result).toMatchObject({ result: 'applied', decision: { toState: 'AWAITING_PUSH' } });
    expect((await end()).result).toMatchObject({ result: 'duplicate' });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_PUSH', currentHeadSha: 'H1', currentRound: 0 });
    expect(await rounds(o.deliveryId)).toEqual([]);
    expect((await effects(o.deliveryId, 'push_recovery')).map((e) => e.dedupe_key)).toEqual([`push_recovery:${o.deliveryId}:L5:1`]);
    const t = (await transitions(o.deliveryId)).at(-1)!;
    expect(t).toMatchObject({ command: 'AttemptEnded', to_state: 'AWAITING_PUSH' });
    expect(t.evidence).toMatchObject({ outcome: 'unproven', localHeadSha: 'L5', commitCount: 2 });
    // Never a completed delivery, and the owner task is not settled as delivered.
    expect((await taskRow(o.ownerTaskId)).status).not.toBe('completed');
  });

  test('S30: an owner hand-off failure with nothing local and the task\'s retry queued stays WORKING (a requeue, no round, no recovery)', async () => {
    const o = await open();
    const w = await seedWorker(o.ownerTaskId, { status: 'failed', prNumber: o.prNumber, commitCount: 0 });
    const r = await seam.attemptEnded({ task: ownerTask(o), workerId: w, status: 'unproven', localHeadSha: null, commitCount: 0, source: 'runner', taskRetryBudgetLeft: true }, deps);
    expect(r.result).toMatchObject({ result: 'applied', decision: { toState: 'WORKING' } });
    expect((await transitions(o.deliveryId)).at(-1)!.evidence).toMatchObject({ outcome: 'unproven', requeue: true });
    expect(await rounds(o.deliveryId)).toEqual([]);
    expect(await effects(o.deliveryId, 'push_recovery')).toEqual([]);
  });

  test('S30: a fix attempt whose hand-off failed with a local commit → AWAITING_PUSH and the attempt ends unproven, never delivered; no fix re-dispatch', async () => {
    const f = await fixing();
    const w = await seedWorker(f.fix.id, { status: 'failed', lastCommitSha: 'L7', commitCount: 1 });
    await seam.attemptEnded({ task: f.fix, workerId: w, status: 'unproven', localHeadSha: 'L7', commitCount: 1, source: 'runner' }, deps);
    const view = await loadView({ deliveryId: f.deliveryId });
    expect(view.delivery).toMatchObject({ state: 'AWAITING_PUSH', currentHeadSha: 'H1', currentRound: 1 });
    expect(view.attempts.find((a) => a.family === 'review_fix')).toMatchObject({ status: 'ended', outcome: 'unproven', reportedShas: ['L7'] });
    expect((await tasksOf(f.deliveryId, 'fix')).length).toBe(1);
    expect((await effects(f.deliveryId, 'push_recovery')).length).toBe(1);
  });

  test('S30: an old runner omits the outcome — the same refusal reads as a plain failure, exactly today\'s behaviour (the fix is re-dispatched)', async () => {
    const f = await fixing();
    const w = await seedWorker(f.fix.id, { status: 'failed', lastCommitSha: 'L7', commitCount: 1 });
    await seam.attemptEnded({ task: f.fix, workerId: w, status: 'failed', localHeadSha: 'L7', commitCount: 1, source: 'runner' }, deps);
    const view = await loadView({ deliveryId: f.deliveryId });
    expect(view.delivery!.state).toBe('CHANGES_REQUESTED');
    expect(view.attempts.find((a) => a.family === 'review_fix' && a.attemptNo === 1)).toMatchObject({ status: 'ended', outcome: 'failed' });
    expect(await effects(f.deliveryId, 'push_recovery')).toEqual([]);
  });
});

describe('S31 — preflight', () => {
  // Tier 1 (create_pr refuses a body CI's prose scan would reject, via the TS port held to the
  // Python script by packages/core/__tests__/no-prod-data-prose.test.ts) is covered in
  // apps/web/src/app/api/github/pr/route.test.ts; tier 2 (the runner's preflight denies the push
  // with the output as the next instruction, attempt open) in
  // apps/runner/__tests__/unit/preflight-guard.test.ts. Tier 3 runs here, on the live CI door.
  test('S31: a CI failure of a preflight class is tagged preflight_miss on its transition; the repair is exactly as without it', async () => {
    const o = await openAndHandOn();
    gh.failing = ['Build', 'No Production Data'];
    const seen = await ciFail(o);
    expect(seen).toMatchObject({ handled: true, result: { result: 'applied', decision: { toState: 'REPAIRING' } } });
    const t = (await transitions(o.deliveryId)).at(-1)!;
    expect(t).toMatchObject({ command: 'CiFailedObserved', to_state: 'REPAIRING' });
    expect(t.evidence).toMatchObject({ preflightMiss: 'No Production Data', signature: 'ci_failed', attemptNo: 1 });
    expect((await ciAttempts(o.deliveryId)).map((a) => [a.attemptNo, a.status])).toEqual([[1, 'queued']]);
  });

  test('S31: a product failure, or an unreadable check list, is not a miss', async () => {
    const o = await openAndHandOn();
    gh.failing = ['Unit tests'];
    await ciFail(o);
    expect((await transitions(o.deliveryId)).at(-1)!.evidence).not.toHaveProperty('preflightMiss');

    const o2 = await openAndHandOn();
    gh.failing = null;
    await ciFail(o2);
    expect((await transitions(o2.deliveryId)).at(-1)!.evidence).not.toHaveProperty('preflightMiss');
  });

  test('S31: a workspace names its own preflight classes (gitConfig.preflight.ciChecks)', async () => {
    const o = await openAndHandOn();
    gh.failing = ['Lint ratchet'];
    const own = { ...deps, repoFor: async () => ({ installationId: 1, repoFullName: REPO, gitConfig: { preflight: { ciChecks: ['lint'] } } }) };
    await ciFail(o, { d: own });
    expect((await transitions(o.deliveryId)).at(-1)!.evidence).toMatchObject({ preflightMiss: 'Lint ratchet' });
  });
});

// ══ S32–S34: release composition ═════════════════════════════════════════════

describe('S32–S34 — release composition', () => {
  const { ingestFact } = facts;
  const RELEASE = { enabled: true, releaseBranch: 'dev', prodBranch: 'main' };
  const setRelease = (cfg: unknown) => q(sql`UPDATE workspaces SET release_config = ${JSON.stringify(cfg)}::jsonb WHERE id = ${workspaceId}::uuid`);

  /** Two task PRs, each approved by a kernel round at its own head (H1). */
  async function reviewedConstituents() {
    const out: Delivery[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await openAndHandOn();
      expect(await verdict(c, 'approve')).toMatchObject({ toState: 'APPROVED' });
      out.push(c);
    }
    return out;
  }

  /**
   * Fake GitHub for the composed PR `agg` (dev → main): its compare lists one
   * squash commit per constituent, the version bump, and any `extra` commits.
   */
  function composedGithub(aggPr: number, cs: Delivery[], o: {
    extra?: Array<{ sha: string; files: string[]; message?: string }>; truncated?: boolean; headRef?: string;
    /** Constituent index whose squash into dev resolved a conflict: what landed differs from the reviewed head. */
    conflictEdit?: number;
  } = {}) {
    const patch = (f: string, body = `+reviewed change to ${f}`) => ({ filename: f, status: 'modified', patch: `@@ -1 +1 @@\n-before\n${body}` });
    const commits = [
      ...cs.map((c, i) => ({ sha: `SQ${i}`, files: [`src/c${i}.ts`], message: `feat: constituent (#${c.prNumber})`, pr: c.prNumber, conflict: o.conflictEdit === i })),
      { sha: 'BUMP', files: ['apps/web/package.json', 'CHANGELOG.md'], message: 'chore: bump version to v9.9.9', pr: null as number | null, conflict: false },
      ...(o.extra ?? []).map((x) => ({ ...x, message: x.message ?? 'edit on the release branch', pr: null as number | null, conflict: false })),
    ];
    const parentOf = (i: number) => (i ? commits[i - 1].sha : 'BASE0');
    ghApi = (path) => {
      if (path === `/repos/${REPO}/pulls/${aggPr}`) return { head: { ref: o.headRef ?? 'dev', sha: gh.head }, base: { ref: 'main' } };
      if (path.startsWith(`/repos/${REPO}/compare/main...`)) return {
        merge_base_commit: { sha: 'BASE0' }, base_commit: { sha: 'BASE0' }, total_commits: o.truncated ? 999 : commits.length,
        commits: commits.map((c, i) => ({ sha: c.sha, parents: [{ sha: parentOf(i) }], commit: { message: c.message } })),
        files: commits.flatMap((c) => c.files).map((filename) => ({ filename })),
      };
      // A constituent's reviewed head (H1), diffed against its squash commit's parent: the change as reviewed.
      const rv = /^\/repos\/[^/]+\/[^/]+\/compare\/([^.]+)\.\.\.H1$/.exec(path);
      const ri = rv ? commits.findIndex((c, i) => c.pr != null && parentOf(i) === rv[1]) : -1;
      if (ri >= 0) return { files: commits[ri].files.map((f) => patch(f)) };
      const m = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)(\/pulls)?$/.exec(path);
      const c = m && commits.find((x) => x.sha === m[1]);
      if (c && !m![2]) return { files: c.files.map((f) => patch(f, c.conflict ? `+conflict resolved by hand in ${f}` : undefined)) };
      if (c) return c.pr == null ? [] : [{ number: c.pr, merged_at: '2026-10-06T00:00:00Z', base: { ref: 'dev' }, head: { sha: 'H1' } }];
      return undefined;
    };
  }

  /** The composed PR, opened after its constituents merged into dev; round 1's dispatch runs the check. */
  async function composedPr(cs: Delivery[], o: Parameters<typeof composedGithub>[2] = {}) {
    await setRelease(RELEASE);
    const agg = await open();
    composedGithub(agg.prNumber, cs, o);
    const workerId = await seedWorker(agg.ownerTaskId, { status: 'completed', lastCommitSha: 'H1', prNumber: agg.prNumber, commitCount: 1 });
    await seam.attemptEnded({ task: ownerTask(agg), workerId, status: 'completed', localHeadSha: 'H1', commitCount: 1, source: 'runner' }, deps);
    await setRelease(null);
    return agg;
  }
  const reviewersFor = (d: Delivery) => q<{ id: string }>(sql`SELECT id FROM tasks WHERE delivery_id = ${d.deliveryId}::uuid AND delivery_role = 'review'`);
  const compositionFacts = (d: Delivery) => q<{ id: string; payload: { attestation: import('../../src/lib/workflow/types').CompositionAttestation } }>(
    sql`SELECT id, payload FROM workflow_facts WHERE workspace_id = ${workspaceId}::uuid AND kind = 'composition_attested' AND pr_number = ${d.prNumber}::int`);

  test('S32/T13: a composition approval carries forward on a content-equivalent push, with no reviewer task anywhere (task 1ebce52a)', async () => {
    const cs = await reviewedConstituents();
    const agg = await composedPr(cs);
    expect(await delivery(agg.deliveryId)).toMatchObject({ state: 'APPROVED', approvalBasis: 'composition', compositionHeads: ['H1'] });
    await push(agg, 'H2', { equivalent: true });
    expect(await delivery(agg.deliveryId)).toMatchObject({ state: 'APPROVED', currentHeadSha: 'H2', compositionHeads: ['H1', 'H2'], approvedHeads: [] });
    expect(await reviewersFor(agg)).toEqual([]);
  });

  test('S32: release PR mechanically composed of reviewed changes → composition attestation accepted, CI still gates, no second reviewer', async () => {
    const cs = await reviewedConstituents();
    const agg = await composedPr(cs);

    const d = await delivery(agg.deliveryId);
    expect(d).toMatchObject({ state: 'APPROVED', approvalBasis: 'composition', compositionHeads: ['H1'], approvedHeads: [] });
    // Covered by composition, never by a verdict at the aggregate head.
    expect(headCoverage(d, 'H1')).toBe('composition');
    expect((await rounds(agg.deliveryId)).map((r) => [r.round, r.status, r.verdict])).toEqual([[1, 'superseded', null]]);
    expect(await reviewersFor(agg)).toEqual([]);
    expect(notified).toEqual([]);
    expect((await effects(agg.deliveryId, 'dispatch_review')).map((e) => e.outcome)).toEqual(['ok:composition_attested']);
    const [t] = (await transitions(agg.deliveryId)).filter((x) => x.command === 'CompositionAttested');
    expect(t.evidence).toMatchObject({ method: 'patch_set_equal', novelDelta: { result: 'none' } });
    expect((t.evidence.constituents as Array<{ prNumber: number }>).map((c) => c.prNumber).sort()).toEqual(cs.map((c) => c.prNumber).sort());

    // CI still gates the aggregate: landing goes through T15's rails like any PR.
    const land = (rails: { passed: boolean; redCi?: boolean }) => applyCommand(
      { type: 'LandingRequested', actor: 'sweep:landing', headSha: 'H1', door: 'sweep', live: live(), rails }, { ref: { deliveryId: agg.deliveryId } });
    expect(await land({ passed: false, redCi: true })).toMatchObject({ result: 'rejected', reason: 'rail_not_overridable' });
    expect(await land({ passed: true })).toMatchObject({ result: 'applied' });
    expect((await transitions(agg.deliveryId)).at(-1)!.evidence).toMatchObject({ coverage: 'composition' });

    // Redelivery (a webhook or sweep replaying the same attestation) is one fact and one transition.
    const [fact] = await compositionFacts(agg);
    const replay = await ingestFact({ kind: 'composition_attested', workspaceId, source: 'sweep:replay', attestation: fact.payload.attestation });
    expect(replay.firstSeen).toBe(false);
    expect((await compositionFacts(agg)).length).toBe(1);
    expect((await transitions(agg.deliveryId)).filter((x) => x.command === 'CompositionAttested').length).toBe(1);
  });

  test('S33: release PR with a novel delta → the delta is reviewed on its own and can still need a human', async () => {
    const cs = await reviewedConstituents();
    const agg = await composedPr(cs, { extra: [{ sha: 'HAND', files: ['packages/core/drizzle/9999_hand.sql'] }] });
    await drain(agg.deliveryId);

    const d = await delivery(agg.deliveryId);
    expect(d).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2, compositionHeads: [], approvedHeads: [] });
    const [r1, r2] = await rounds(agg.deliveryId);
    expect([r1.status, r2.kind, r2.status]).toEqual(['superseded', 'delta', 'queued']);
    const [scope] = await q<{ scope: { novelDeltaPaths: string[]; composition: boolean } }>(sql`SELECT scope FROM workflow_review_rounds WHERE id = ${r2.id}::uuid`);
    expect(scope.scope).toMatchObject({ composition: true, novelDeltaPaths: ['packages/core/drizzle/9999_hand.sql'] });
    // Only the delta round gets a reviewer; prior verdicts cover the constituents only.
    expect(reviewersCreated.filter((x) => x.round === 2).length).toBe(1);
    expect((await reviewersFor(agg)).length).toBe(1);

    expect(await verdict(agg, 'escalate')).toMatchObject({ handled: true, toState: 'ESCALATED' });
    expect(await delivery(agg.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_escalated', compositionHeads: [] });
  });

  test('S33: a delta-round approve stays a composition approval covering the delta only, never a whole-release verdict', async () => {
    const cs = await reviewedConstituents();
    const agg = await composedPr(cs, { extra: [{ sha: 'HAND', files: ['packages/core/drizzle/9999_hand.sql'] }] });
    await drain(agg.deliveryId);
    const [, r2] = await rounds(agg.deliveryId);
    posted = []; postedBodies = [];

    expect(await verdict(agg, 'approve')).toMatchObject({ handled: true, toState: 'APPROVED' });
    await drain(agg.deliveryId);
    const d = await delivery(agg.deliveryId);
    expect(d).toMatchObject({ state: 'APPROVED', approvalBasis: 'composition', compositionHeads: ['H1'], approvedHeads: [] });
    expect(d.approvalBasis).not.toBe('verdict');
    expect(headCoverage(d, 'H1')).toBe('composition');
    const [t] = (await transitions(agg.deliveryId)).filter((x) => x.command === 'ReviewVerdictRecorded');
    expect(t.evidence).toMatchObject({ compositionDelta: { roundId: r2.id, paths: ['packages/core/drizzle/9999_hand.sql'] } });

    // The GitHub review and the headline both say the review covered only the delta.
    expect(posted).toEqual([{ commitId: 'H1', event: 'APPROVE' }]);
    expect(postedBodies[0]).toStartWith('Release-only changes approved');
    expect(postedBodies[0]).toContain('packages/core/drizzle/9999_hand.sql');
    const view = (await getDeliveryViewsForTasks([agg.ownerTaskId])).get(agg.ownerTaskId)!;
    expect(view.headline).not.toBe('Approved');
    expect(view.headline).toBe('Release-only changes approved');
  });

  test('S33 regression: a conflict resolved while squashing into dev is a novel delta, never "none"', async () => {
    const cs = await reviewedConstituents();
    // GitHub associates SQ0 with constituent 0's PR (approved at H1), but the squash differs from H1's diff.
    const agg = await composedPr(cs, { conflictEdit: 0 });
    await drain(agg.deliveryId);

    const d = await delivery(agg.deliveryId);
    expect(d).toMatchObject({ state: 'AWAITING_REVIEW', compositionHeads: [], approvedHeads: [], approvalBasis: null });
    const [t] = (await transitions(agg.deliveryId)).filter((x) => x.command === 'CompositionAttested');
    expect(t.evidence.novelDelta).toEqual({ result: 'present', paths: ['src/c0.ts'] });
    // Only the constituent whose landed patch equals its reviewed one is cited, at its composed commit.
    expect(t.evidence.constituents).toEqual([expect.objectContaining({ prNumber: cs[1].prNumber, reviewedHeadSha: 'H1', mergedHeadSha: 'H1', landedSha: 'SQ1' })]);
    const [, r2] = await rounds(agg.deliveryId);
    expect([r2.kind, r2.status]).toEqual(['delta', 'queued']);
  });

  test('S34: composition proof fails closed; ordinary PRs stay exact-head bound; verification idempotent under redelivery', async () => {
    const cs = await reviewedConstituents();

    // Unverifiable (a truncated compare): nothing claimed, the normal full review runs.
    const trunc = await composedPr(cs, { truncated: true });
    expect(await delivery(trunc.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', compositionHeads: [], approvalBasis: null });
    expect(await compositionFacts(trunc)).toEqual([]);
    expect((await reviewersFor(trunc)).length).toBe(1);

    // An ordinary PR (not release, not a mission integration PR) is never composed.
    const ordinary = await composedPr(cs, { headRef: 'buildd/abc-feature' });
    expect(await delivery(ordinary.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', compositionHeads: [] });
    expect(await compositionFacts(ordinary)).toEqual([]);
    expect(headCoverage(await delivery(ordinary.deliveryId), 'H1')).toBe('none');

    // A forged constituent (wrong reviewed head) and a stale aggregate head are refused at the reducer.
    const [c0] = cs;
    const [round] = await rounds(c0.deliveryId);
    const forged = {
      repoFullName: REPO, prNumber: trunc.prNumber, baseSha: 'BASE0', aggregateHeadSha: 'H1', method: 'patch_set_equal' as const,
      verifiedAt: '2026-10-07T00:00:00Z', verifier: 'kernel',
      constituents: [{ deliveryId: c0.deliveryId, roundId: round.id, prNumber: c0.prNumber, reviewedHeadSha: 'NOT-REVIEWED', equivalentHeadShas: [], landedSha: 'NOT-REVIEWED' }],
      novelDelta: { result: 'none' as const },
    };
    expect(await ingestFact({ kind: 'composition_attested', workspaceId, source: 'test', attestation: forged })).toMatchObject({ result: 'rejected', reason: 'composition_not_verified' });
    const stale = { ...forged, aggregateHeadSha: 'H-OLD', constituents: [{ ...forged.constituents[0], reviewedHeadSha: 'H1', landedSha: 'H1' }] };
    expect(await ingestFact({ kind: 'composition_attested', workspaceId, source: 'test', attestation: stale })).toMatchObject({ result: 'stale' });
    expect(await delivery(trunc.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', compositionHeads: [], approvalBasis: null });
  });
});

// ══ S35–S37: human attention and state truth ═════════════════════════════════

describe('S35–S37 — owner of the next move', () => {
  const views = (ids: string[]) => getDeliveryViewsForTasks(ids);
  const escFor = (o: Delivery, extra: Record<string, unknown> = {}) => ({
    workerId: 'w', taskId: o.ownerTaskId, taskTitle: 'feat: matrix owner', workspaceId, workspaceName: 'm', prNumber: o.prNumber,
    prUrl: `https://github.com/${REPO}/pull/${o.prNumber}`, policyTier: 'agent-review' as const, escalationReason: 'raw column says human',
    waitingMinutes: 1, prOpenedAt: new Date(), prLifecycleVerifiedAt: new Date(), prLifecycleStatus: 'ci_green', prLifecycleUpdatedAt: new Date(), ...extra,
  });

  test('S35: a replaced predecessor stays auditable but never reads FAILED while its replacement is current', async () => {
    const o = await openAndHandOn();
    const f = await fixing(o);
    const w1 = await seedWorker(f.fix.id, { status: 'failed' });
    await seam.attemptEnded({ task: f.fix, workerId: w1, status: 'lost', localHeadSha: null, commitCount: 0, source: 'sweep:stale-workers' }, deps);
    await q(sql`UPDATE tasks SET status = 'failed' WHERE id = ${f.fix.id}::uuid`);
    const fixes = await tasksOf(o.deliveryId, 'fix');
    expect(fixes.length).toBe(2);

    const v = (await views([f.fix.id])).get(f.fix.id)!;
    expect(v.state).toBe('CHANGES_REQUESTED');
    expect(v.currentAttempt?.taskId).toBe(fixes[1].id);
    expect(v.history.find((h) => h.taskId === f.fix.id)).toMatchObject({ status: 'failed', superseded: true });
    expect(v.stage).not.toBe('failed');

    // Mission projection: the failed predecessor is replaced work (explain and the mission page read this).
    expect([...(await kernelReplacedFailedTaskIds([f.fix.id]))]).toEqual([f.fix.id]);
    // Home: no FAILED card for it.
    const queue = buildActionQueue([{ kind: 'failed', taskId: f.fix.id, taskTitle: 'fix', failureMessage: 'lost' } as never], [], { deliveryViews: await views([f.fix.id]) });
    expect(queue.find((c) => c.chip === 'FAILED')).toBeUndefined();
  });

  test('S36: AWAITING_PUSH is platform-owned with its evidence; only ESCALATED is Needs You', async () => {
    const a = await awaitingPush();
    let v = (await views([a.ownerTaskId])).get(a.ownerTaskId)!;
    expect(v).toMatchObject({ state: 'AWAITING_PUSH', owner: 'platform', needsYou: false, headline: 'Waiting for the fix to reach GitHub' });
    expect(v.detail).toContain(`PR #${a.prNumber}`);
    // A raw human-review column on the same PR does not make it Needs You.
    let [card] = buildActionQueue([], [escFor(a, { humanReview: { reason: 'worker waiting_input' } }) as never], { deliveryViews: await views([a.ownerTaskId]) });
    expect(isActionableChip(card.chip)).toBe(false);
    expect(card.delivery?.owner).toBe('platform');

    // The same delivery escalated by its reviewer: now a person owns it, with the reason.
    const o = await openAndHandOn();
    await verdict(o, 'escalate');
    v = (await views([o.ownerTaskId])).get(o.ownerTaskId)!;
    expect(v).toMatchObject({ state: 'ESCALATED', owner: 'human', needsYou: true });
    [card] = buildActionQueue([], [escFor(o, { prLifecycleStatus: 'ci_running' }) as never], { deliveryViews: await views([o.ownerTaskId]) });
    expect(isActionableChip(card.chip)).toBe(true);
  });

  test('S37: a stalled conflict fix is recovered in place; duplicates create no second task; the CTA names the real transition', async () => {
    const o = await openAndHandOn();
    await q(sql`UPDATE workflow_deliveries SET mergeable = 'dirty', mergeable_head_sha = current_head_sha WHERE id = ${o.deliveryId}::uuid`);

    // No remediation yet: the CTA is to create one.
    let v = (await views([o.ownerTaskId])).get(o.ownerTaskId)!;
    expect(v.cta).toEqual({ action: 'create_conflict_fix', label: 'Resolve conflicts' });

    // A conflict fix filed earlier that no runner ever claimed.
    const cf = await seedTask(workspaceId, { status: 'pending', title: 'fix(conflict): matrix' });
    await q(sql`UPDATE tasks SET conflict_retry_pr_number = ${o.prNumber}::int, conflict_retry_head_sha = 'H0', creation_source = 'conflict',
      created_at = now() - interval '45 minutes', updated_at = now() - interval '45 minutes' WHERE id = ${cf}::uuid`);
    v = (await views([o.ownerTaskId])).get(o.ownerTaskId)!;
    expect(v.headline).toBe('Conflict fix stalled');
    expect(v.cta).toEqual({ action: 'repair_remediation', label: 'Run fix', taskId: cf });
    expect(v.needsYou).toBe(false);

    // A sweep, a webhook and a human click arrive together: one recovery, no new task.
    const params = { workerId: 'none', taskId: o.ownerTaskId, prNumber: o.prNumber, headSha: 'H1', repoFullName: REPO, workspaceId };
    const results = await Promise.all([
      dispatchConflictRetry({ ...params, humanInitiated: true }),
      dispatchConflictRetry({ ...params, humanInitiated: true }),
      dispatchConflictRetry({ ...params, humanInitiated: true }),
    ]);
    for (const r of results) expect(r).toMatchObject({ dispatched: false, inFlightTaskId: cf });
    expect(results.filter((r) => r.remediationRecovery === 'redispatch').length).toBe(1);
    const filed = await q<{ id: string }>(sql`SELECT id FROM tasks WHERE workspace_id = ${workspaceId}::uuid AND conflict_retry_pr_number = ${o.prNumber}::int`);
    expect(filed.map((t) => t.id)).toEqual([cf]);

    // Re-dispatched: the CTA reads the real next transition, the fix running again.
    v = (await views([o.ownerTaskId])).get(o.ownerTaskId)!;
    expect(v.headline).toBe('Resolving conflicts');
    expect(v.cta).toBeNull();
    // And a later click before the new wait expires changes nothing.
    expect(await dispatchConflictRetry({ ...params, humanInitiated: true })).toEqual({ dispatched: false, inFlightTaskId: cf });
  });
});

// ══ AC-14 / §10.3: a spent budget or a dead effect always reaches a person (67d34094) ══

describe('AC-14 / §10.3 — no platform-owned state without an exit (67d34094)', () => {
  const floor = (o: Delivery) => seam.reconcileKernelDeliveries(deps, { only: [o.deliveryId], minQuietMs: 0 });
  /** The effect's next try is its last: the drain sees it go dead. */
  const lastTry = (deliveryId: string, kind: string) => q(sql`UPDATE workflow_effects SET attempt_count = 7, not_before = now() - interval '1 second'
    WHERE delivery_id = ${deliveryId}::uuid AND kind = ${kind} AND status = 'pending'`);
  const deadGates = (deliveryId: string) => q<{ outcome: string; workspace_id: string; detail: Record<string, unknown> }>(
    sql`SELECT outcome, workspace_id, detail FROM gate_events WHERE gate = 'workflow_effect_dead' AND detail->>'deliveryId' = ${deliveryId}`);
  /** A fix attempt ends: `fail` = the worker died with nothing pushed; otherwise it pushed `head`. */
  async function endFix(t: { id: string } & Record<string, unknown>, o: { fail: true } | { head: string; from: string }) {
    if ('fail' in o) {
      const w = await seedWorker(t.id, { status: 'failed' });
      return seam.attemptEnded({ task: t as never, workerId: w, status: 'failed', localHeadSha: null, commitCount: 0, source: 'runner' }, deps);
    }
    gh.head = o.head; gh.ancestors[o.head] = [o.from];
    const w = await seedWorker(t.id, { status: 'completed', lastCommitSha: o.head, commitCount: 1 });
    return seam.attemptEnded({ task: t as never, workerId: w, status: 'completed', localHeadSha: o.head, commitCount: 1, source: 'runner' }, deps);
  }
  const claimNewestFix = async (deliveryId: string) => {
    const t = (await taskRow((await tasksOf(deliveryId, 'fix')).at(-1)!.id)).task;
    expect(await seam.claimFix(t, deps)).toEqual({ action: 'proceed' });
    return t;
  };

  test('fix 1 and 2 fail, fix 3 delivers, round 2 requests changes: the spent fix budget is ESCALATED(review_exhausted) and a person is told', async () => {
    const f = await fixing();
    expect((await delivery(f.deliveryId)).maxRounds).toBe(3);
    await endFix(f.fix, { fail: true });
    await endFix(await claimNewestFix(f.deliveryId), { fail: true });
    await endFix(await claimNewestFix(f.deliveryId), { head: 'H2', from: 'H1' });
    expect(await delivery(f.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H2', currentRound: 2 });

    await verdict(f, 'request-changes', 'H2');
    const d = await delivery(f.deliveryId);
    expect(d).toMatchObject({ state: 'ESCALATED', stateReason: 'review_exhausted' });
    expect((await transitions(f.deliveryId)).at(-1)).toMatchObject({ command: 'FixDispatched', to_state: 'ESCALATED' });
    // No fourth fix task, the escalation notice ran once, the request-changes review was still posted.
    expect((await tasksOf(f.deliveryId, 'fix')).length).toBe(3);
    expect(exhaustions).toBe(1);
    expect(posted.filter((p) => p.commitId === 'H2' && p.event === 'REQUEST_CHANGES').length).toBe(1);
    expect((await effects(f.deliveryId, 'dispatch_fix')).at(-1)!.outcome).toBe('ok:escalated_budget_exhausted');
    // The floor owes nothing more (it used to see the dispatch key and stop, leaving CHANGES_REQUESTED forever).
    expect(await floor(f)).toMatchObject({ enqueued: 0 });
    expect((await delivery(f.deliveryId)).state).toBe('ESCALATED');
  });

  test('a dead merge_call: LANDING → ESCALATED(landing_needs_human), a person is told, the gate event is written, and a door no longer reads landing_in_flight', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    expect(await applyCommand({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live(), rails: { passed: true } }, { ref: { deliveryId: o.deliveryId } }))
      .toMatchObject({ result: 'applied' });
    override = { merge_call: async () => { throw new Error('GitHub API error: 502'); } };
    await lastTry(o.deliveryId, 'merge_call');
    await drain(o.deliveryId);

    expect((await effects(o.deliveryId, 'merge_call'))[0]).toMatchObject({ status: 'dead', last_error: 'GitHub API error: 502' });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'landing_needs_human' });
    expect((await transitions(o.deliveryId)).at(-1)).toMatchObject({ command: 'EffectDead', to_state: 'ESCALATED' });
    expect(notified.some((t) => t.includes(`PR #${o.prNumber} needs a person`))).toBe(true);
    const [gate] = await deadGates(o.deliveryId);
    expect(gate).toMatchObject({ outcome: 'stranded', workspace_id: workspaceId, detail: { kind: 'merge_call', critical: true, applied: true } });
    // ESCALATED is human-owned: no door is told a landing is in flight.
    const again = await applyCommand({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live(), rails: { passed: true } }, { ref: { deliveryId: o.deliveryId } });
    expect(again).toMatchObject({ result: 'rejected', reason: 'state_not_allowed' });
  });

  test('a verify_merge that keeps throwing escalates too; a non-critical dead effect only writes the gate event', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    await applyCommand({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live(), rails: { passed: true } }, { ref: { deliveryId: o.deliveryId } });
    await applyCommand({ type: 'MergeCallResult', actor: 'kernel', headSha: 'H1', outcome: 'indeterminate' }, { ref: { deliveryId: o.deliveryId } });
    override = {
      merge_call: async () => ({ outcome: 'ok:test' }),
      verify_merge: async () => { throw new Error('live PR read failed'); },
      render_activity: async () => { throw new Error('comment API down'); },
    };
    await lastTry(o.deliveryId, 'verify_merge');
    await lastTry(o.deliveryId, 'render_activity');
    await drain(o.deliveryId);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'landing_needs_human' });
    const gates = await deadGates(o.deliveryId);
    expect(gates.find((g) => g.detail.kind === 'verify_merge')).toMatchObject({ outcome: 'stranded', detail: { applied: true } });
    expect(gates.find((g) => g.detail.kind === 'render_activity')).toMatchObject({ outcome: 'warned', detail: { critical: false, applied: false } });
  });

  test('a dead push_recovery: AWAITING_PUSH → ESCALATED(push_undeliverable), and a person is told', async () => {
    const p = await awaitingPush();
    override = { push_recovery: async () => { throw new Error('no GitHub installation for the workspace'); } };
    await lastTry(p.deliveryId, 'push_recovery');
    await drain(p.deliveryId);
    expect(await delivery(p.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'push_undeliverable' });
    expect(notified.some((t) => t.includes('never reached GitHub'))).toBe(true);
    expect((await deadGates(p.deliveryId))[0]).toMatchObject({ outcome: 'stranded', detail: { kind: 'push_recovery', applied: true } });
  });

  test('floor: a dead push_recovery chain (its escalation lost) is re-owed as the last try, which is T22', async () => {
    const p = await awaitingPush();
    // The row died before dead effects escalated: nothing moved the delivery.
    await q(sql`UPDATE workflow_effects SET status = 'dead' WHERE delivery_id = ${p.deliveryId}::uuid AND kind = 'push_recovery'`);
    expect(await floor(p)).toMatchObject({ enqueued: 1 });
    expect(await delivery(p.deliveryId)).toMatchObject({ state: 'ESCALATED', stateReason: 'push_undeliverable' });
    expect((await effects(p.deliveryId, 'push_recovery')).map((e) => [e.dedupe_key.split(':').at(-1), e.status])).toEqual([['1', 'dead'], ['final', 'done']]);
  });

  test('floor: LANDING with a dead merge_call (its escalation lost) re-reads the PR: open → APPROVED (landable again); merged → MERGED', async () => {
    for (const merged of [false, true]) {
      const o = await openAndHandOn();
      await verdict(o, 'approve');
      await applyCommand({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live(), rails: { passed: true } }, { ref: { deliveryId: o.deliveryId } });
      await q(sql`UPDATE workflow_effects SET status = 'dead' WHERE delivery_id = ${o.deliveryId}::uuid AND kind = 'merge_call'`);
      if (merged) { gh.state = 'closed'; gh.merged = true; gh.updatedAt = 'u-merged'; }
      await floor(o);
      expect((await delivery(o.deliveryId)).state).toBe(merged ? 'MERGED' : 'APPROVED');
      gh = { head: 'H1', state: 'open', merged: false, updatedAt: 'u0', ancestors: {} };
    }
  });

  test('floor: LANDING whose merge call is still retrying is left alone', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    await applyCommand({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live(), rails: { passed: true } }, { ref: { deliveryId: o.deliveryId } });
    await q(sql`UPDATE workflow_effects SET not_before = now() + interval '1 hour' WHERE delivery_id = ${o.deliveryId}::uuid AND kind = 'merge_call'`);
    expect(await floor(o)).toMatchObject({ enqueued: 0 });
    expect((await delivery(o.deliveryId)).state).toBe('LANDING');
  });
});

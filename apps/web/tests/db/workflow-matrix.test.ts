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
 *   - "spec Slice B/C/D": no task filed yet (§14).
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { LivePr } from '../../src/lib/workflow/commands';
import type { GithubFactReader } from '../../src/lib/workflow/facts';
import type { EffectHandler, EffectHandlers } from '../../src/lib/workflow/effects';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const REPO = 'acme/matrix';
let workspaceId: string;
let prSeq = 9100;

// ── Fake GitHub: one PR whose head, state and ancestry a test moves ─────────

interface FakePr { head: string; state: 'open' | 'closed'; merged: boolean; updatedAt: string; ancestors: Record<string, string[]>; ciGreen?: boolean | null; failing?: string[] | null }
let gh: FakePr;
const live = (): LivePr => ({
  state: gh.state, merged: gh.merged, headSha: gh.head, headRepoFullName: REPO, baseRef: 'dev', updatedAt: gh.updatedAt,
  mergedAt: gh.merged ? '2026-10-06T00:00:00Z' : null, mergeCommitSha: gh.merged ? `M-${gh.head}` : null,
});
const reader: GithubFactReader = {
  readPr: async () => live(),
  contains: async (_repo, ancestor, head) => ancestor === head || (gh.ancestors[head] ?? []).includes(ancestor),
  ciGreen: async () => gh.ciGreen ?? null,
  failingChecks: async () => gh.failing ?? null,
};
const repoFor = async () => ({ installationId: 1, repoFullName: REPO, gitConfig: null });

// ── Side-effect leaves, recorded ────────────────────────────────────────────

let posted: Array<{ commitId: string; event: string }>;
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
async function fakeGithubApi(_installationId: number, path: string, opts?: RequestInit): Promise<unknown> {
  const method = opts?.method ?? 'GET';
  if (ghApi && method === 'GET' && !/\/issues\//.test(path)) { const out = ghApi(path); if (out !== undefined) return out; }
  if (!/\/issues\//.test(path)) return null;
  const id = /comments\/(\d+)$/.exec(path);
  if (method === 'GET') return path.includes('page=1') ? [...comments.entries()].map(([cid, body]) => ({ id: cid, body })) : [];
  if (method === 'POST') { const cid = commentSeq++; comments.set(cid, JSON.parse(String(opts!.body)).body); return { id: cid }; }
  if (method === 'PATCH' && id) { comments.set(Number(id[1]), JSON.parse(String(opts!.body)).body); return null; }
  if (method === 'DELETE' && id) { comments.delete(Number(id[1])); return null; }
  return null;
}
mock.module('../../src/lib/github', () => ({
  ...realGithub,
  githubApi: fakeGithubApi,
  postPrReview: async (p: { headSha: string; event: string }) => { posted.push({ commitId: p.headSha, event: p.event }); return { posted: true }; },
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
/** The composition root's set (apps/web/src/modules.ts): review loop plus the CI family. */
const reviewEffectHandlers = withCiRetryEffects(reviewOnly);
const { runEffects } = await import('../../src/lib/workflow/effects');
const { applyCommand, loadView } = await import('../../src/lib/workflow/kernel');
const { attemptView, headCoverage } = await import('../../src/lib/workflow/reducer');
const facts = await import('../../src/lib/workflow/facts');
const { kernelDeliveryForPr } = await import('../../src/lib/workflow/authority');
const { getDeliveryViewsForTasks, kernelReplacedFailedTaskIds } = await import('../../src/lib/workflow/delivery-view');
const { buildActionQueue, isActionableChip } = await import('../../src/lib/action-queue');
const { dispatchConflictRetry } = await import('../../src/lib/conflict-retry');
const { HeaderStatusPill } = await import('../../src/app/app/(protected)/tasks/[id]/TaskSidePanel');
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

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
  ({ workspaceId } = await seedWorkspace());
});
beforeEach(() => {
  gh = { head: 'H1', state: 'open', merged: false, updatedAt: 'u0', ancestors: {} };
  posted = []; activity = []; notified = []; exhaustions = 0; reviewersCreated = []; override = {}; activityEntries = []; ciEscalations = []; ghApi = null;
  comments = new Map();
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
const push = (o: Delivery, head: string, extra: { carryForward?: 'content_equivalent' | 'own_refresh' | null; ancestors?: string[] } = {}) => {
  gh.head = head;
  if (extra.ancestors) gh.ancestors[head] = extra.ancestors;
  return seam.observeHead({
    workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, hintedHeadSha: head, source: 'webhook:synchronize',
    ...(extra.carryForward !== undefined ? { carryForward: async () => extra.carryForward ?? null } : {}),
  }, deps);
};
const closeOrMerge = (o: Delivery, merged: boolean, updatedAt = 'u1') => {
  gh.state = 'closed'; gh.merged = merged; gh.updatedAt = updatedAt;
  return seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'webhook:closed' }, deps);
};

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
    await push(o, 'H2', { carryForward: null });
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
    const obs = () => seam.observeHead({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, hintedHeadSha: 'H2', source: 'webhook:synchronize', carryForward: async () => 'content_equivalent' }, deps);
    await Promise.all([obs(), obs(), obs()]);
    const d = await delivery(o.deliveryId);
    expect(d).toMatchObject({ state: 'APPROVED', currentHeadSha: 'H2', approvedHeads: ['H1', 'H2'] });
    expect((await transitions(o.deliveryId)).filter((t) => t.command === 'HeadObserved' && t.to_state === 'APPROVED').length).toBe(1);
    expect(reviewersCreated.length).toBe(1);
  });

  test('the platform\'s own refresh carries forward; a later non-equivalent push is still re-reviewed', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    await push(o, 'H2', { carryForward: 'own_refresh' });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'APPROVED', approvedHeads: ['H1', 'H2'] });
    await push(o, 'H3', { carryForward: null });
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H3', currentRound: 2, approvedHeads: ['H1', 'H2'] });
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
    const facts = await q(sql`SELECT 1 FROM workflow_facts WHERE workspace_id = ${workspaceId}::uuid AND fact_key = ${`head:${REPO}#${o.prNumber}:H2`}`);
    expect(facts.length).toBe(1);
    expect(reviewersCreated.length).toBe(2);
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

  // Intended: the same sequence leaves workers.prLifecycleStatus / mergedAt as the merge set them,
  // and a check_suite failure for the pre-merge SHA neither overwrites CI on the delivery nor files
  // a CI fix (T10: head_not_current; recordPrFact funnel replaces the direct column writers).
  test.todo('S6: workers PR columns unchanged and an old-SHA CI failure does not overwrite (needs spec Slice B: fact funnel / recordPrFact — no task filed)');
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
  // is pinned at current_head_sha. Landing is still the legacy door (§13.1 deviation 2).
  test('S10 (kernel): merge indeterminate and a double merge call → LANDING pinned at the head, one verify_merge, one PrMerged', async () => {
    const o = await openAndHandOn();
    await verdict(o, 'approve');
    const land = () => applyCommand({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live(), rails: { passed: true } }, { ref: { deliveryId: o.deliveryId } });
    expect(await land()).toMatchObject({ result: 'applied' });
    expect(await land()).toMatchObject({ result: 'duplicate' });
    const [mc] = await effects(o.deliveryId, 'merge_call');
    expect(mc.dedupe_key).toBe(`merge_call:${o.deliveryId}:H1`);
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

  // Intended: the five merge doors (auto-merge, landPr, the merge route, PUT /api/github/pr, the
  // sweep) issue LandingRequested/MergeCallResult instead of merging directly (§13.1 deviation 2).
  test.todo('S10: the merge doors call T15/T16 instead of merging directly (needs spec Slice C landing — no task filed)');

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

  // Intended: T20 only from CLOSED_UNMERGED, authorised on the CALLER's task naming the PR (not the
  // owner's), an existing edge never overwritten, and canCompleteMission treats the superseded PR as
  // shipped — through POST /api/github/pr/supersede and record_pr_supersession. An attempt to
  // overwrite must come back REFUSED (409 edge_exists): today applyCommand answers it `duplicate`
  // via the target-less stable key `supersede:{pr}` (see S18 below).
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

  // Intended: POST /api/github/pr/supersede and record_pr_supersession call T20, authorised on the
  // CALLER's task naming the PR (not the owner's), and canCompleteMission treats the superseded PR
  // as shipped from the delivery.
  test.todo('S12: the supersede route and record_pr_supersession call T20 on the caller\'s task (needs spec Slice D — no task filed)');

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
      await push(o, next, { ancestors: [head], carryForward: 'own_refresh' });
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
  test.todo('S15: landPr / the landing sweep drive the treadmill through T16 and refresh_branch (needs spec Slice B/C — no task filed)');
});

// ══ S16–S21: projections and authorization ═══════════════════════════════════

describe('S16–S21', () => {
  // Intended: for every legacy input (SUPERSEDED/ABANDONED/open/closed deliveries) canCompleteMission
  // and prShipState answer exactly as before the kernel; with deliveries present they read the
  // delivery instead and agree.
  test.todo('S16: canCompleteMission identical for all legacy inputs once it reads deliveries (needs spec Slice D — no task filed)');

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
    // A different target never overwrites the edge. (Live answer: `duplicate` of the first
    // transition, because the stable key `supersede:{pr}` carries no target; the pure reducer
    // says rejected(edge_exists). S12's todo owns surfacing that as a refusal.)
    expect((await supersede(f, 4343)).result).not.toBe('applied');
    expect(await delivery(f.deliveryId)).toMatchObject({ state: 'SUPERSEDED', supersededByPr: 4242 });
  });

  test('S18 (part 1): a closed PR that reopens comes back to review at its live head', async () => {
    const o = await openAndHandOn();
    await closeOrMerge(o, false, 'u-closed');
    gh.state = 'open'; gh.updatedAt = 'u-reopened'; gh.head = 'H2';
    await seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'webhook:reopened' }, deps);
    expect(await delivery(o.deliveryId)).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: 'H2', currentRound: 2 });
  });

  // Intended: deleting the mission integration branch closes the task PR as
  // CLOSED_UNMERGED(base_deleted) (pr_closed ingests the cause from the live base-ref read; today it
  // is always 'unknown'), scan_supersession finds the re-opened PR and T20 records it.
  test.todo('S18: integration branch deleted → CLOSED_UNMERGED(base_deleted), scan_supersession, T20 (needs spec Slice D — no task filed)');

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

  // Intended: POST /api/prs/[prNumber]/merge and /api/github/pr answer HTTP 409 with `current` when
  // the caller's version is stale, and apply nothing.
  test.todo('S20: HTTP 409 + current view from the merge and PR routes on a stale version (needs spec Slice C — no task filed)');

  // Intended: owner task, a caller task that names the PR, a sibling task, another workspace and a
  // human against supersede/review routes and task-token auth (§17.1).
  test.todo('S21: authorization matrix for supersede/review routes (needs spec Slice D — no task filed)');
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
  // Intended: one signature red on trunk and several PRs → one trunk_incidents row, one trunk-fix
  // task, zero per-PR ci attempts (queued ones skipped), deliveries BLOCKED_ON_TRUNK, ci budget
  // untouched, TrunkRecovered re-enters resume_state; two dependency-bot PRs accumulate no retries.
  test.todo('S24: trunk breakage → one incident, one trunk fix, BLOCKED_ON_TRUNK, recovery resumes (needs spec Slice B — no task filed)');

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
  test.todo('S25: conflict-resolved targets skipped at dispatch and claim for the conflict family (needs spec Slice B — no task filed)');

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
  test.todo('S27: mechanical vs agent repair for conflict and migration families (needs spec Slice B — no task filed)');
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
  function composedGithub(aggPr: number, cs: Delivery[], o: { extra?: Array<{ sha: string; files: string[]; message?: string }>; truncated?: boolean; headRef?: string } = {}) {
    const commits = [
      ...cs.map((c, i) => ({ sha: `SQ${i}`, files: [`src/c${i}.ts`], message: `feat: constituent (#${c.prNumber})`, pr: c.prNumber })),
      { sha: 'BUMP', files: ['apps/web/package.json', 'CHANGELOG.md'], message: 'chore: bump version to v9.9.9', pr: null as number | null },
      ...(o.extra ?? []).map((x) => ({ ...x, message: x.message ?? 'edit on the release branch', pr: null as number | null })),
    ];
    ghApi = (path) => {
      if (path === `/repos/${REPO}/pulls/${aggPr}`) return { head: { ref: o.headRef ?? 'dev' }, base: { ref: 'main' } };
      if (path.startsWith(`/repos/${REPO}/compare/main...`)) return {
        merge_base_commit: { sha: 'BASE0' }, base_commit: { sha: 'BASE0' }, total_commits: o.truncated ? 999 : commits.length,
        commits: commits.map((c, i) => ({ sha: c.sha, parents: [{ sha: i ? commits[i - 1].sha : 'BASE0' }], commit: { message: c.message } })),
        files: commits.flatMap((c) => c.files).map((filename) => ({ filename })),
      };
      const m = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)(\/pulls)?$/.exec(path);
      const c = m && commits.find((x) => x.sha === m[1]);
      if (c && !m![2]) return { files: c.files.map((filename) => ({ filename })) };
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

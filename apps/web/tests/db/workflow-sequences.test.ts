/**
 * Random event sequences through the real workflow kernel, on real Postgres,
 * against the stateful fake GitHub with its faults switched on
 * (docs/specs/workflow-state-kernel.md; fake: src/lib/workflow/testing/fake-github.ts).
 *
 * Each run opens one delivery, then interprets a fast-check generated list of
 * actions: GitHub events (pushes, force pushes, base moves, CI, merges and
 * closes by a person, webhook delivery with drop / duplicate / reorder / early
 * faults), runner reports (owner and fix attempts ending, local heads), review
 * verdicts and reviewer failures, fix claims, landing doors, conflict doors,
 * the kernel floor, the effect drain and clock advances. Every seam call is the
 * one a route or sweep makes; only the non-GitHub leaves are stubbed (reviewer
 * prompt, dispatch wake, team notifications, scope reconcile).
 *
 * Invariants are checked after every step, and the GitHub writes at the moment
 * the kernel makes them (see `checkInvariants` and `guardCalls`). After the last
 * input the run settles (faults off, clock forward, floor, drain until nothing
 * moves) and checks liveness, then replays every fact it fed the kernel and
 * checks each replay is a no-op.
 *
 * Runtime is bounded: KERNEL_SEQ_RUNS runs (default 12, about 15s) of at most
 * KERNEL_SEQ_MAX_ACTS + 4 actions (default 30). KERNEL_SEQ_SEED changes the base
 * seed (fixed by default, so CI is deterministic). A failure reports the seed,
 * the shrunk spec and the error; the shrunk spec becomes a named case in
 * REGRESSIONS. KERNEL_SEQ_VERBOSE=1 prints each run's transition path to stderr,
 * KERNEL_SEQ_ONLY='<RunSpec JSON>' runs one spec.
 *
 *   KERNEL_SEQ_RUNS=500 KERNEL_SEQ_SEED=$RANDOM bun run test:db apps/web/tests/db/workflow-sequences.test.ts
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import fc from 'fast-check';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

// ── Leaves that are not GitHub ──────────────────────────────────────────────

/** The run's guard for "a reviewer is dispatched only for an open round at the current head". */
let onReviewerCreated: (p: { deliveryId: string; roundId: string; headSha: string }) => Promise<void> = async () => {};
let currentWorkspaceId = '';
const realReviewer = await import('../../src/lib/reviewer');
mock.module('../../src/lib/reviewer', () => ({
  ...realReviewer,
  createReviewerTask: async (p: { workflowRound: { deliveryId: string; roundId: string; round: number }; headSha: string }) => {
    await onReviewerCreated({ deliveryId: p.workflowRound.deliveryId, roundId: p.workflowRound.roundId, headSha: p.headSha });
    const taskId = await seedTask(currentWorkspaceId, { status: 'pending', title: `review r${p.workflowRound.round}` });
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
type Fake = InstanceType<typeof FakeGithub>;
type WebhookDelivery = import('../../src/lib/workflow/testing/fake-github').WebhookDelivery;
type Faults = import('../../src/lib/workflow/testing/fake-github').Faults;
const seam = await import('../../src/lib/workflow/seam');
const { loadView } = await import('../../src/lib/workflow/kernel');
const { getDeliveryViewsForTasks } = await import('../../src/lib/workflow/delivery-view');
const { isTerminal } = await import('../../src/lib/workflow/types');

// ── Actions ─────────────────────────────────────────────────────────────────

type Outcome = 'completed' | 'failed' | 'lost' | 'unproven';
export type Act =
  | { t: 'deliver' }
  | { t: 'push' }
  | { t: 'foreignPush' }
  | { t: 'forcePush' }
  | { t: 'advanceBase'; conflict: boolean }
  | { t: 'ci'; ok: boolean }
  | { t: 'ownerEnds'; outcome: Outcome; localOnly: boolean; retry: boolean }
  | { t: 'verdict'; v: 'approve' | 'request_changes' | 'escalate'; oldest: boolean }
  | { t: 'reviewerFails'; reason: 'prose_verdict' | 'no_verdict' | 'infra' }
  | { t: 'fixClaim' }
  | { t: 'fixEnds'; outcome: Outcome; push: boolean }
  | { t: 'land' }
  | { t: 'conflictDoor'; hint: 'dirty' | 'behind' }
  | { t: 'humanMerge' }
  | { t: 'humanClose' }
  | { t: 'humanReopen' }
  | { t: 'floor' }
  | { t: 'ciSweep' }
  | { t: 'clock' }
  | { t: 'drain' };

const outcomeArb = fc.constantFrom<Outcome>('completed', 'completed', 'failed', 'lost', 'unproven');
const ownerEndsArb: fc.Arbitrary<Act> = fc.record({
  t: fc.constant('ownerEnds' as const), outcome: outcomeArb, localOnly: fc.constantFrom(false, false, false, true), retry: fc.boolean(),
});
const actArb: fc.Arbitrary<Act> = fc.oneof(
  { weight: 16, arbitrary: fc.constant<Act>({ t: 'deliver' }) },
  { weight: 12, arbitrary: fc.constant<Act>({ t: 'push' }) },
  { weight: 4, arbitrary: fc.constant<Act>({ t: 'foreignPush' }) },
  { weight: 4, arbitrary: fc.constant<Act>({ t: 'forcePush' }) },
  { weight: 8, arbitrary: fc.record({ t: fc.constant('advanceBase' as const), conflict: fc.boolean() }) },
  { weight: 16, arbitrary: fc.record({ t: fc.constant('ci' as const), ok: fc.constantFrom(true, true, false) }) },
  { weight: 8, arbitrary: ownerEndsArb },
  { weight: 16, arbitrary: fc.record({ t: fc.constant('verdict' as const), v: fc.constantFrom('approve' as const, 'approve' as const, 'request_changes' as const, 'request_changes' as const, 'escalate' as const), oldest: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('reviewerFails' as const), reason: fc.constantFrom('prose_verdict' as const, 'no_verdict' as const, 'infra' as const) }) },
  { weight: 12, arbitrary: fc.constant<Act>({ t: 'fixClaim' }) },
  { weight: 12, arbitrary: fc.record({ t: fc.constant('fixEnds' as const), outcome: outcomeArb, push: fc.boolean() }) },
  { weight: 16, arbitrary: fc.constant<Act>({ t: 'land' }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('conflictDoor' as const), hint: fc.constantFrom('dirty' as const, 'behind' as const) }) },
  { weight: 1, arbitrary: fc.constant<Act>({ t: 'humanMerge' }) },
  { weight: 1, arbitrary: fc.constant<Act>({ t: 'humanClose' }) },
  { weight: 1, arbitrary: fc.constant<Act>({ t: 'humanReopen' }) },
  { weight: 8, arbitrary: fc.constant<Act>({ t: 'floor' }) },
  { weight: 4, arbitrary: fc.constant<Act>({ t: 'ciSweep' }) },
  { weight: 8, arbitrary: fc.constant<Act>({ t: 'clock' }) },
  { weight: 4, arbitrary: fc.constant<Act>({ t: 'drain' }) },
);

const MAX_ACTS = Number(process.env.KERNEL_SEQ_MAX_ACTS ?? 30);

export interface RunSpec { seed: number; faults: Faults; strict: boolean; acts: Act[]; enforceKnownGaps?: boolean }

/**
 * Facts whose replay is known not to be a no-op, each pinned by a skipped
 * regression case below and owned by a fix task. The random runs leave them
 * out of the replay check so they keep exploring for other failures; the fix
 * removes the entry and unskips its case.
 *  - reviewerFails: T27 keys on the round's failure count, not on the reviewer
 *    that failed, so a repeated report re-queues again (fix task 04a79514).
 */
const KNOWN_REPLAY_GAPS: ReadonlySet<Act['t']> = new Set(['reviewerFails']);

const rate = (max: number) => fc.integer({ min: 0, max: Math.round(max * 100) }).map((n) => n / 100);
const faultsArb: fc.Arbitrary<Faults> = fc.record({
  webhookDrop: rate(0.3),
  webhookDuplicate: rate(0.3),
  webhookReorder: rate(0.3),
  webhookEarly: rate(0.3),
  mergeableUnknownReads: fc.integer({ min: 0, max: 2 }),
  headMovesBeforeWrite: rate(0.2),
  serverError: rate(0.1),
  rateLimit: rate(0.05),
  lostResponse: rate(0.2),
  staleChecks: rate(0.2),
});
const runArb: fc.Arbitrary<RunSpec> = fc.record({
  seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
  faults: faultsArb,
  strict: fc.boolean(),
  // Most runs get past the owner attempt: a few events, the owner's end, then anything.
  acts: fc.tuple(
    fc.array(actArb, { maxLength: 3 }),
    fc.option(ownerEndsArb, { freq: 6, nil: undefined }),
    fc.array(actArb, { minLength: 1, maxLength: MAX_ACTS }),
  ).map(([pre, end, rest]) => [...pre, ...(end ? [end] : []), ...rest]),
});

// ── One run ─────────────────────────────────────────────────────────────────

const BASE = 'dev';
const BRANCH = 'feat/seq';
const CI_MAX = 2;
let installationRowId: string;
let installationId: number;
let runNo = 0;

class InvariantError extends Error {}
const fail = (step: string, msg: string): never => { throw new InvariantError(`[${step}] ${msg}`); };
/**
 * A violation seen inside the kernel's own call path (a GitHub write, a reviewer
 * dispatch). The effect drain catches what a handler throws, so it is also
 * recorded and the next step's checkInvariants fails on it.
 */
const violate = (ctx: Ctx, msg: string): never => { ctx.violations.push(`[${ctx.step}] ${msg}`); return fail(ctx.step, msg); };
/** A GitHub transport failure surfaced by a seam call: a route would answer 5xx and the caller retries. */
const transient = (e: unknown) => /GitHub API error: (5\d\d|403)|Bad Gateway|rate limit/i.test(String((e as Error)?.message ?? e));

type Replay = () => Promise<unknown>;

interface Ctx {
  gh: Fake;
  restoreFetch: () => void;
  repo: string;
  workspaceId: string;
  ownerTaskId: string;
  deliveryId: string;
  prNumber: number;
  ownerAlive: boolean;
  /** Fix tasks this run claimed and that are still running: task id → worker id. */
  running: Map<string, string>;
  /** Every fact fed to the kernel, in order, for the replay check. */
  replays: Replay[];
  replayLabels: string[];
  terminalSeen: string | null;
  /** Check even the known gaps (KNOWN_REPLAY_GAPS, knownLimbo): the regression cases that pin those bugs. */
  enforceKnownGaps: boolean;
  step: string;
  /** Violations recorded at call time (see `violate`). */
  violations: string[];
  /** Errors a seam call threw that were not GitHub transport failures. */
  surprises: string[];
  log: string[];
}

async function guardedSeam<T>(ctx: Ctx, what: string, f: () => Promise<T>): Promise<T | undefined> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof InvariantError) throw e;
    if (transient(e)) { ctx.log.push(`${what}: transient ${String((e as Error).message).slice(0, 80)}`); return undefined; }
    ctx.surprises.push(`${ctx.step} ${what}: ${String((e as Error)?.stack ?? e).slice(0, 400)}`);
    return undefined;
  }
}

type RunRow = { head_sha: string; status: string; conclusion: string | null };
/** Check runs on `sha` as GitHub's REST answers them (read through the fake's own request, never the kernel's reader). */
async function checkRuns(ctx: Ctx, sha: string): Promise<RunRow[]> {
  const res = await ctx.gh.request('GET', `/repos/${ctx.repo}/commits/${sha}/check-runs`);
  return ((res.body as { check_runs?: RunRow[] })?.check_runs ?? []).filter((r) => r.head_sha === sha);
}
async function ciGreenNow(ctx: Ctx, sha: string): Promise<boolean> {
  const runs = await checkRuns(ctx, sha);
  return runs.length > 0 && runs.every((r) => r.status === 'completed' && r.conclusion === 'success');
}

const NOT_FED = Symbol('not fed');
/**
 * Feed one fact to the kernel the way its caller does: a GitHub transport
 * failure surfaces as a 5xx and the runner / reviewer / sweep retries (up to 3
 * times here). Only a fact the kernel actually took joins the replay log; one
 * whose every try failed never reached it, so replaying it later is a first delivery.
 */
async function feed<T>(ctx: Ctx, what: string, run: () => Promise<T>, o: { replay?: Replay | null; took?: (r: T) => boolean } = {}): Promise<T | typeof NOT_FED> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let threw = false;
    let done = false;
    const r = await guardedSeam(ctx, what, async () => {
      try { const v = await run(); done = true; return v; } catch (e) { if (transient(e)) threw = true; throw e; }
    });
    if (threw) continue;
    if (!done) return NOT_FED;
    if (o.replay !== null && (!o.took || o.took(r as T))) ctx.replays.push(o.replay ?? (run as Replay)); ctx.replayLabels.push(`${ctx.step} ${what}`);
    return r as T;
  }
  return NOT_FED;
}

/** The webhook route's and the PR subscribers' mapping from an event to the kernel seam. */
function ingestFor(ctx: Ctx) {
  return async (d: WebhookDelivery): Promise<void> => {
    const p = d.payload as Record<string, any>;
    const base = { workspaceId: ctx.workspaceId, repoFullName: String(p.repository.full_name), installationId: Number(p.installation.id) };
    const run = async () => {
      if (d.name === 'pull_request' && Number(p.number) === ctx.prNumber) {
        if (p.action === 'synchronize') await seam.observeHead({ ...base, prNumber: ctx.prNumber, hintedHeadSha: String(p.after ?? p.pull_request.head.sha), source: 'webhook:synchronize' });
        if (p.action === 'closed' || p.action === 'reopened') await seam.observePrState({ ...base, prNumber: ctx.prNumber, source: `webhook:${p.action}` });
      }
      if (d.name === 'check_suite' && p.action === 'completed' && p.check_suite.conclusion === 'failure') {
        for (const ref of p.check_suite.pull_requests ?? []) {
          if (Number(ref.number) !== ctx.prNumber) continue;
          await seam.observeCiFailure({ ...base, prNumber: ctx.prNumber, headSha: String(p.check_suite.head_sha), signature: 'ci_failed', maxAttempts: CI_MAX, source: 'webhook:check_suite' });
        }
      }
    };
    await feed(ctx, `webhook ${d.name}.${p.action ?? ''}`, run);
  };
}

async function setup(spec: RunSpec): Promise<Ctx> {
  runNo++;
  const { workspaceId } = await seedWorkspace();
  currentWorkspaceId = workspaceId;
  const repo = `acme/seq-${Date.now().toString(36)}-${runNo}`;
  const [r] = await q<{ id: string }>(sql`INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner, default_branch)
    VALUES (${installationRowId}::uuid, ${installationId + runNo}, ${repo}, ${repo.split('/')[1]}, 'acme', ${BASE}) RETURNING id`);
  await q(sql`UPDATE workspaces SET github_installation_id = ${installationRowId}::uuid, github_repo_id = ${r.id}::uuid WHERE id = ${workspaceId}::uuid`);

  const gh = new FakeGithub({ installationId, seed: spec.seed });
  const restoreFetch = gh.installFetch();
  gh.createRepo(repo, { defaultBranch: BASE, files: { 'src/a.ts': 'a0\n', 'src/b.ts': 'b0\n' } });
  if (spec.strict) gh.protect(repo, BASE, { strict: true });
  const ownerTaskId = await seedTask(workspaceId, { status: 'in_progress', title: 'feat: seq' });
  const h1 = gh.push(repo, BRANCH, { 'src/a.ts': 'a1\n' });
  const prNumber = gh.openPr(repo, { head: BRANCH, base: BASE, title: 'feat: seq' });
  await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, commit_count)
    VALUES (${workspaceId}::uuid, ${ownerTaskId}::uuid, 'owner', 'test', ${BRANCH}, 'running', ${h1}, ${prNumber}, ${`https://github.com/${repo}/pull/${prNumber}`}, 1)`);
  gh.discardWebhooks();
  // create_pr opens the delivery (faults off: the PR exists and is readable).
  const opened = await seam.openKernelDelivery({ workspaceId, ownerTaskId, repoFullName: repo, prNumber, installationId, source: 'create_pr' });
  if (!opened.deliveryId) { restoreFetch(); throw new Error(`setup: delivery not opened (${opened.reason})`); }
  gh.setFaults(spec.faults);

  const ctx: Ctx = {
    gh, restoreFetch, repo, workspaceId, ownerTaskId, deliveryId: opened.deliveryId, prNumber, ownerAlive: true,
    running: new Map(), replays: [], replayLabels: [], terminalSeen: null, enforceKnownGaps: spec.enforceKnownGaps ?? false, step: 'setup', violations: [], surprises: [], log: [],
  };
  gh.onWebhook(ingestFor(ctx));
  guardCalls(ctx);
  onReviewerCreated = async (p) => {
    const d = await delivery(ctx);
    const [round] = await q<{ status: string; head_sha: string }>(sql`SELECT status, head_sha FROM workflow_review_rounds WHERE id = ${p.roundId}::uuid`);
    if (!round || !['queued', 'reviewing'].includes(round.status)) violate(ctx, `reviewer dispatched for round ${p.roundId} in status ${round?.status}`);
    if (round.head_sha !== p.headSha || d.current_head_sha !== p.headSha) violate(ctx, `reviewer dispatched at ${p.headSha.slice(0, 7)} for round at ${round.head_sha.slice(0, 7)}; delivery head ${String(d.current_head_sha).slice(0, 7)}`);
  };
  return ctx;
}

type DeliveryRow = {
  state: string; state_reason: string | null; version: number; current_head_sha: string | null; current_round: number;
  approved_heads: string[] | null; composition_heads: string[] | null; approval_basis: string | null;
  merge_commit_sha: string | null; merged_at: string | null; pr_number: number | null;
};
async function delivery(ctx: Ctx): Promise<DeliveryRow> {
  const [d] = await q<DeliveryRow>(sql`SELECT state, state_reason, version, current_head_sha, current_round, approved_heads, composition_heads,
    approval_basis, merge_commit_sha, merged_at, pr_number FROM workflow_deliveries WHERE id = ${ctx.deliveryId}::uuid`);
  return d;
}
const covered = (d: DeliveryRow, sha: string | null) =>
  !!sha && (d.approval_basis === 'policy' || (d.approved_heads ?? []).includes(sha) || (d.composition_heads ?? []).includes(sha));

/**
 * Reads the kernel's helpers make that the fake does not model (fake-github.ts
 * is left unchanged), answered with the empty truth of these runs:
 *  - the supersession scan's timeline after a close: nothing cross-references the PR;
 *  - the CI-fix brief's job list for a failed suite: no job logs to quote.
 */
function unmodelledRead(path: string): unknown {
  if (/\/issues\/\d+\/timeline(\?|$)/.test(path)) return [];
  if (/\/actions\/runs\/\d+\/jobs(\?|$)/.test(path)) return { total_count: 0, jobs: [] };
  return undefined;
}

/** Checks made at the moment the kernel writes to GitHub: the write is for the current head and a live decision. */
function guardCalls(ctx: Ctx): void {
  const gh = ctx.gh;
  const original = gh.request.bind(gh);
  gh.request = async (method: string, path: string, body?: unknown) => {
    const b = (body ?? {}) as Record<string, any>;
    if (method === 'PUT' && path.endsWith(`/pulls/${ctx.prNumber}/merge`)) {
      const d = await delivery(ctx);
      if (!b.sha) violate(ctx, 'merge call not pinned to a sha');
      if (d.state !== 'LANDING') violate(ctx, `merge call while ${d.state}`);
      if (d.current_head_sha !== b.sha) violate(ctx, `merge call pinned to ${String(b.sha).slice(0, 7)}, delivery head ${String(d.current_head_sha).slice(0, 7)}`);
      if (!covered(d, b.sha)) violate(ctx, `merge call for uncovered head ${String(b.sha).slice(0, 7)}`);
    }
    if (method === 'POST' && path.endsWith(`/pulls/${ctx.prNumber}/reviews`) && (b.event === 'APPROVE' || b.event === 'REQUEST_CHANGES')) {
      const verdict = b.event === 'APPROVE' ? 'approve' : 'request_changes';
      const rounds = await q<{ id: string }>(sql`SELECT id FROM workflow_review_rounds WHERE delivery_id = ${ctx.deliveryId}::uuid
        AND head_sha = ${String(b.commit_id ?? '')} AND status = 'decided' AND effective_verdict = ${verdict}`);
      if (!rounds.length) violate(ctx, `GitHub ${b.event} posted at ${String(b.commit_id).slice(0, 7)} with no decided ${verdict} round at that head`);
    }
    if (method === 'PUT' && path.endsWith(`/pulls/${ctx.prNumber}/update-branch`)) {
      const d = await delivery(ctx);
      if (b.expected_head_sha !== d.current_head_sha) violate(ctx, `update-branch pinned to ${String(b.expected_head_sha).slice(0, 7)}, delivery head ${String(d.current_head_sha).slice(0, 7)}`);
    }
    const extra = method === 'GET' ? unmodelledRead(path) : undefined;
    if (extra !== undefined) return { status: 200, body: extra };
    return original(method, path, body);
  };
}

// ── Invariants after every step ─────────────────────────────────────────────

async function checkInvariants(ctx: Ctx): Promise<void> {
  const s = ctx.step;
  if (ctx.violations.length) fail(s, `violation inside the kernel's call path: ${ctx.violations.join('; ')}`);
  const d = await delivery(ctx);
  const pr = ctx.gh.pr(ctx.repo, ctx.prNumber);

  // Version strictly increases, one per transition, one transition per idempotency key.
  const tr = await q<{ from_version: number; to_version: number; idempotency_key: string; command: string; to_state: string }>(sql`SELECT from_version, to_version,
    idempotency_key, command, to_state FROM workflow_transitions WHERE delivery_id = ${ctx.deliveryId}::uuid ORDER BY to_version`);
  tr.forEach((t, i) => {
    if (Number(t.to_version) !== Number(t.from_version) + 1) fail(s, `transition ${t.command} ${t.from_version}→${t.to_version}`);
    if (i > 0 && Number(t.from_version) !== Number(tr[i - 1].to_version)) fail(s, `version gap before ${t.command}: ${tr[i - 1].to_version}→${t.from_version}`);
  });
  if (Number(d.version) !== Number(tr.at(-1)?.to_version ?? 0)) fail(s, `version ${d.version} ≠ last transition ${tr.at(-1)?.to_version}`);
  if (new Set(tr.map((t) => t.idempotency_key)).size !== tr.length) fail(s, 'two transitions share an idempotency key');
  if (tr.length && tr.at(-1)!.to_state !== d.state) fail(s, `state ${d.state} ≠ last transition's ${tr.at(-1)!.to_state}`);

  // A terminal state wins over every later fact (§4 rule 1).
  if (ctx.terminalSeen && d.state !== ctx.terminalSeen) fail(s, `left terminal ${ctx.terminalSeen} for ${d.state}`);
  if (isTerminal(d.state as never)) ctx.terminalSeen = d.state;

  // No MERGED without a merge commit the fake made.
  if (d.state === 'MERGED') {
    if (!pr.merged || !pr.mergeCommitSha) fail(s, 'MERGED but the PR is not merged on GitHub');
    if (d.merge_commit_sha !== pr.mergeCommitSha) fail(s, `MERGED with merge commit ${d.merge_commit_sha} ≠ GitHub's ${pr.mergeCommitSha}`);
    if (!ctx.gh.isAncestor(ctx.repo, pr.mergeCommitSha!, BASE)) fail(s, 'merge commit is not on the base branch');
  }
  if (tr.filter((t) => t.command === 'PrMerged').length > 1) fail(s, 'PrMerged applied twice');

  // The kernel's head is one GitHub actually held for this PR (set only from live reads).
  const heads = [...pr.previousHeads, pr.headSha];
  if (d.current_head_sha && !heads.includes(d.current_head_sha)) fail(s, `current head ${d.current_head_sha.slice(0, 7)} was never the PR head`);

  // APPROVED / LANDING stand on an approval of the current head (§8.1).
  if ((d.state === 'APPROVED' || d.state === 'LANDING') && !covered(d, d.current_head_sha)) fail(s, `${d.state} at an uncovered head`);
  // Reasons are named.
  if (['ESCALATED', 'REPAIRING', 'CLOSED_UNMERGED'].includes(d.state) && !d.state_reason) fail(s, `${d.state} without a reason`);

  // At most one landing effect in flight.
  const fx = await q<{ kind: string; status: string }>(sql`SELECT kind, status FROM workflow_effects WHERE delivery_id = ${ctx.deliveryId}::uuid`);
  const landing = fx.filter((e) => e.kind === 'merge_call' && (e.status === 'pending' || e.status === 'delivering'));
  if (landing.length > 1) fail(s, `${landing.length} merge_call effects in flight`);

  // Rounds: numbered 1..n, single-flight, the open one at the current head.
  const rounds = await q<{ round: number; status: string; head_sha: string }>(sql`SELECT round, status, head_sha FROM workflow_review_rounds
    WHERE delivery_id = ${ctx.deliveryId}::uuid ORDER BY round`);
  rounds.forEach((r, i) => { if (Number(r.round) !== i + 1) fail(s, `round numbers not contiguous: ${rounds.map((x) => x.round).join(',')}`); });
  if (rounds.length && Number(d.current_round) !== rounds.length) fail(s, `current_round ${d.current_round} ≠ newest round ${rounds.length}`);
  const open = rounds.filter((r) => r.status === 'queued' || r.status === 'reviewing');
  if (open.length > 1) fail(s, `${open.length} open review rounds`);
  if (d.state === 'AWAITING_REVIEW' && open.length === 1 && open[0].head_sha !== d.current_head_sha) fail(s, `open round at ${open[0].head_sha.slice(0, 7)}, head ${String(d.current_head_sha).slice(0, 7)}`);

  // Ledger: automatic attempts stay inside their frozen budget.
  const over = await q<{ family: string; attempt_no: number; max_attempts: number }>(sql`SELECT family, attempt_no, max_attempts FROM workflow_attempts
    WHERE delivery_id = ${ctx.deliveryId}::uuid AND trigger = 'automatic' AND attempt_no > max_attempts`);
  if (over.length) fail(s, `attempt over budget: ${JSON.stringify(over)}`);

  // The DeliveryView projection agrees with the delivery row.
  const view = (await getDeliveryViewsForTasks([ctx.ownerTaskId])).get(ctx.ownerTaskId);
  if (!view) fail(s, 'no DeliveryView for the owner task');
  const want = { state: d.state, stateReason: d.state_reason, version: Number(d.version), headSha: d.current_head_sha, prNumber: d.pr_number };
  const got = { state: view!.state, stateReason: view!.stateReason, version: view!.version, headSha: view!.headSha, prNumber: view!.prNumber };
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(s, `DeliveryView ${JSON.stringify(got)} ≠ row ${JSON.stringify(want)}`);
  if (isTerminal(d.state as never) !== (view!.owner === 'none')) fail(s, `state ${d.state} with next-move owner ${view!.owner}`);
  if (view!.needsYou !== (view!.owner === 'human')) fail(s, `needsYou ${view!.needsYou} with owner ${view!.owner}`);
  if (d.state === 'MERGED' && view!.prState !== 'merged') fail(s, `MERGED shown as ${view!.prState}`);
}

// ── The interpreter ─────────────────────────────────────────────────────────

let shaSeq = 0;
const localOnlySha = () => `${(++shaSeq).toString(16).padStart(8, '0')}${'f'.repeat(32)}`;

async function workerRow(ctx: Ctx, taskId: string, status: string, sha: string | null): Promise<string> {
  const [w] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, commit_count)
    VALUES (${ctx.workspaceId}::uuid, ${taskId}::uuid, 'w', 'test', ${BRANCH}, ${status}, ${sha}, ${ctx.prNumber}, ${`https://github.com/${ctx.repo}/pull/${ctx.prNumber}`}, 1) RETURNING id`);
  return w.id;
}

async function step(ctx: Ctx, a: Act, i: number): Promise<void> {
  const gh = ctx.gh;
  const pr = gh.pr(ctx.repo, ctx.prNumber);
  const open = pr.state === 'open';
  const base = { workspaceId: ctx.workspaceId, repoFullName: ctx.repo, prNumber: ctx.prNumber, installationId };
  const n = `${i}`;
  switch (a.t) {
    case 'deliver': await gh.deliverWebhooks(); return;
    case 'push': if (open) gh.push(ctx.repo, BRANCH, { 'src/a.ts': `a-${n}\n` }); return;
    case 'foreignPush': if (open) gh.push(ctx.repo, BRANCH, { [`src/p${n}.ts`]: 'x\n' }, { pusher: 'a-person' }); return;
    case 'forcePush': if (open) gh.forcePush(ctx.repo, BRANCH); return;
    case 'advanceBase': gh.advanceBase(ctx.repo, BASE, a.conflict ? { 'src/a.ts': `base-${n}\n` } : { 'src/b.ts': `b-${n}\n` }); return;
    case 'ci': if (open) gh.setCheck(ctx.repo, pr.headSha, 'build', { conclusion: a.ok ? 'success' : 'failure' }); return;
    case 'ownerEnds': {
      if (!ctx.ownerAlive) return;
      const local = a.localOnly ? localOnlySha() : (gh.branchHead(ctx.repo, BRANCH) ?? null);
      const retry = a.retry && a.outcome !== 'completed';
      const workerId = await workerRow(ctx, ctx.ownerTaskId, a.outcome === 'completed' ? 'completed' : 'failed', local);
      if (!retry) {
        ctx.ownerAlive = false;
        await q(sql`UPDATE tasks SET status = ${a.outcome === 'completed' ? 'completed' : 'failed'} WHERE id = ${ctx.ownerTaskId}::uuid`);
      }
      const run = () => seam.attemptEnded({
        task: { id: ctx.ownerTaskId, workspaceId: ctx.workspaceId, deliveryId: ctx.deliveryId, deliveryRole: 'owner', context: null },
        workerId, status: a.outcome, localHeadSha: local, commitCount: 1, source: 'runner', ...(retry ? { taskRetryBudgetLeft: true } : {}),
      });
      await feed(ctx, 'ownerEnds', run);
      return;
    }
    case 'verdict': {
      const rows = await q<{ id: string; context: Record<string, unknown> }>(sql`SELECT id, context FROM tasks WHERE delivery_id = ${ctx.deliveryId}::uuid
        AND delivery_role = 'review' AND status IN ('pending', 'in_progress') ORDER BY created_at ${a.oldest ? sql`ASC` : sql`DESC`} LIMIT 1`);
      const t = rows[0];
      if (!t) return;
      await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${t.id}::uuid`);
      const run = () => seam.recordReviewVerdict({
        reviewerTask: { id: t.id, deliveryId: ctx.deliveryId, context: t.context },
        verdict: a.v, effectiveVerdict: a.v, headSha: String(t.context.headSha), confidence: 0.9,
      });
      await feed(ctx, 'verdict', run);
      return;
    }
    case 'reviewerFails': {
      const [t] = await q<{ id: string; context: Record<string, unknown> }>(sql`SELECT id, context FROM tasks WHERE delivery_id = ${ctx.deliveryId}::uuid
        AND delivery_role = 'review' AND status IN ('pending', 'in_progress') ORDER BY created_at DESC LIMIT 1`);
      if (!t) return;
      await q(sql`UPDATE tasks SET status = 'failed' WHERE id = ${t.id}::uuid`);
      const workerId = await workerRow(ctx, t.id, 'failed', null);
      const run = () => seam.attemptEnded({
        task: { id: t.id, workspaceId: ctx.workspaceId, deliveryId: ctx.deliveryId, deliveryRole: 'review', context: t.context },
        workerId, status: 'failed', localHeadSha: null, commitCount: 0, source: 'runner', reviewFailure: a.reason,
      });
      await feed(ctx, 'reviewerFails', run, KNOWN_REPLAY_GAPS.has('reviewerFails') && !ctx.enforceKnownGaps ? { replay: null } : {});
      return;
    }
    case 'fixClaim': {
      const [t] = await q<{ id: string; delivery_role: string; context: Record<string, unknown> }>(sql`SELECT id, delivery_role, context FROM tasks
        WHERE delivery_id = ${ctx.deliveryId}::uuid AND delivery_role IN ('fix', 'ci_fix', 'conflict_fix') AND status = 'pending' ORDER BY created_at LIMIT 1`);
      if (!t) return;
      const task = { id: t.id, workspaceId: ctx.workspaceId, deliveryId: ctx.deliveryId, deliveryRole: t.delivery_role, context: t.context };
      const run = () => seam.claimFix(task);
      const decision = await feed(ctx, 'fixClaim', run, {
        replay: async () => { const r = await run(); if (r.action === 'cancel') await seam.cancelSkippedTask(t.id, r.reason); },
        took: (r) => r.action !== 'defer',
      });
      if (decision === NOT_FED) return;
      if (decision.action === 'cancel') { await seam.cancelSkippedTask(t.id, decision.reason); return; }
      if (decision.action === 'defer') return;
      await q(sql`UPDATE tasks SET status = 'in_progress' WHERE id = ${t.id}::uuid`);
      ctx.running.set(t.id, await workerRow(ctx, t.id, 'running', null));
      // A fix that proceeds is bound to the current head (§10.5 at claim).
      const v = await loadView({ deliveryId: ctx.deliveryId });
      const att = v.attempts.find((x) => x.id === t.context.workflowAttemptId);
      if (att && att.boundHeadSha !== v.delivery?.currentHeadSha) fail(ctx.step, `fix claimed for ${att.boundHeadSha?.slice(0, 7)} while head ${v.delivery?.currentHeadSha?.slice(0, 7)}`);
      return;
    }
    case 'fixEnds': {
      const [first] = ctx.running.entries();
      if (!first) return;
      const [taskId] = first;
      ctx.running.delete(taskId);
      const [t] = await q<{ delivery_role: string; context: Record<string, unknown> }>(sql`SELECT delivery_role, context FROM tasks WHERE id = ${taskId}::uuid`);
      const task = { id: taskId, workspaceId: ctx.workspaceId, deliveryId: ctx.deliveryId, deliveryRole: t.delivery_role, context: t.context };
      let local: string | null = localOnlySha();
      if (a.push && gh.pr(ctx.repo, ctx.prNumber).state === 'open') local = gh.push(ctx.repo, BRANCH, { 'src/a.ts': `fix-${n}\n` });
      await seam.recordLocalHead(taskId, local);
      let status: Outcome = a.outcome;
      if (status === 'completed') {
        // §9 completion gate: a refused completion is a worker that never reports again (the reaper's `lost`).
        const refusal = await guardedSeam(ctx, 'fixCompletionGate', () => seam.fixCompletionGate({ task, localHeadSha: local }));
        if (refusal) status = 'lost';
      }
      await q(sql`UPDATE tasks SET status = ${status === 'completed' ? 'completed' : 'failed'} WHERE id = ${taskId}::uuid`);
      const workerId = await workerRow(ctx, taskId, status === 'completed' ? 'completed' : 'failed', local);
      const run = () => seam.attemptEnded({ task, workerId, status, localHeadSha: local, commitCount: 1, source: 'runner' });
      await feed(ctx, 'fixEnds', run);
      return;
    }
    case 'land': {
      // The door's rails: open, CI green on the head it read (internal truth, not a faulted read).
      if (!open) return;
      const head = pr.headSha;
      if (!(await ciGreenNow(ctx, head))) return;
      await guardedSeam(ctx, 'land', () => seam.landThroughKernel({ ...base, headSha: head, door: 'auto_merge', actor: 'system:auto_merge' }));
      return;
    }
    case 'conflictDoor':
      if (!open) return;
      await guardedSeam(ctx, 'conflictDoor', () => seam.observeConflict({ ...base, hint: a.hint, isDependencyBot: false, maxAgentAttempts: 2, source: 'door:conflict' }));
      return;
    case 'humanMerge': if (open) { try { gh.mergePr(ctx.repo, ctx.prNumber, { by: 'a-person' }); } catch { /* GitHub refused (conflict, draft) */ } } return;
    case 'humanClose': if (open) gh.closePr(ctx.repo, ctx.prNumber, 'a-person'); return;
    case 'humanReopen': if (!open && !pr.merged) { try { gh.reopenPr(ctx.repo, ctx.prNumber, 'a-person'); } catch { /* base gone */ } } return;
    case 'ciSweep': await ciSweep(ctx); return;
    case 'floor': await guardedSeam(ctx, 'floor', () => seam.reconcileKernelDeliveries({}, { only: [ctx.deliveryId], minQuietMs: 0 })); return;
    case 'clock': await advanceClock(ctx); await guardedSeam(ctx, 'drain', () => seam.drainDelivery(ctx.deliveryId)); return;
    case 'drain': await guardedSeam(ctx, 'drain', () => seam.drainDelivery(ctx.deliveryId)); return;
  }
}

/**
 * The red-PR / dead-zone sweeps' kernel door (§11 "import a fact"): CI read red
 * on the PR's live head goes through the same T10 call the check_suite webhook makes.
 */
async function ciSweep(ctx: Ctx): Promise<void> {
  const pr = ctx.gh.pr(ctx.repo, ctx.prNumber);
  if (pr.state !== 'open') return;
  const headSha = pr.headSha; // `pr` is the fake's live object: pin the head this read was about
  const runs = await checkRuns(ctx, headSha);
  if (!runs.some((r) => r.status === 'completed' && r.conclusion === 'failure')) return;
  const run = () => seam.observeCiFailure({ workspaceId: ctx.workspaceId, repoFullName: ctx.repo, prNumber: ctx.prNumber, installationId,
    headSha, signature: 'ci_failed', maxAttempts: CI_MAX, source: 'sweep:ci-red' });
  await feed(ctx, 'ciSweep', run);
}

/** Time passes: every backoff and lease of this delivery's effects is due now. */
async function advanceClock(ctx: Ctx): Promise<void> {
  await q(sql`UPDATE workflow_effects SET not_before = now() - interval '1 second',
    lease_until = CASE WHEN status = 'delivering' THEN now() - interval '1 second' ELSE lease_until END
    WHERE delivery_id = ${ctx.deliveryId}::uuid AND status IN ('pending', 'delivering')`);
}

async function fingerprint(ctx: Ctx): Promise<string> {
  const [r] = await q<{ v: number; fx: number; fxs: string; tasks: number }>(sql`SELECT
    (SELECT version FROM workflow_deliveries WHERE id = ${ctx.deliveryId}::uuid) AS v,
    (SELECT count(*)::int FROM workflow_effects WHERE delivery_id = ${ctx.deliveryId}::uuid) AS fx,
    (SELECT string_agg(status, ',' ORDER BY id) FROM workflow_effects WHERE delivery_id = ${ctx.deliveryId}::uuid) AS fxs,
    (SELECT count(*)::int FROM tasks WHERE delivery_id = ${ctx.deliveryId}::uuid) AS tasks`);
  return JSON.stringify(r);
}

/** Inputs stopped: GitHub recovers, time passes, the floor and drain run until nothing moves. */
async function settle(ctx: Ctx): Promise<void> {
  ctx.gh.setFaults({ webhookDrop: 0, webhookDuplicate: 0, webhookReorder: 0, webhookEarly: 0, mergeableUnknownReads: 0, headMovesBeforeWrite: 0, serverError: 0, rateLimit: 0, lostResponse: 0, staleChecks: 0 });
  let last = '';
  for (let i = 0; i < 16; i++) {
    ctx.step = `settle#${i}`;
    await ctx.gh.deliverWebhooks();
    await advanceClock(ctx);
    await guardedSeam(ctx, 'floor', () => seam.reconcileKernelDeliveries({}, { only: [ctx.deliveryId], minQuietMs: 0 }));
    await ciSweep(ctx);
    await guardedSeam(ctx, 'drain', () => seam.drainDelivery(ctx.deliveryId));
    await checkInvariants(ctx);
    const fp = await fingerprint(ctx);
    if (fp === last) return;
    last = fp;
  }
  fail(ctx.step, 'did not settle in 16 passes');
}

/** §4 / §11: after settling, terminal or waiting on a named external input. */
async function checkLiveness(ctx: Ctx): Promise<void> {
  const s = 'liveness';
  const d = await delivery(ctx);
  const pending = await q<{ kind: string; status: string }>(sql`SELECT kind, status FROM workflow_effects WHERE delivery_id = ${ctx.deliveryId}::uuid AND status IN ('pending', 'delivering')`);
  if (pending.length) fail(s, `effects still owed after settling: ${pending.map((e) => `${e.kind}:${e.status}`).join(', ')}`);
  const openTasks = async (roles: string[]) => (await q<{ id: string }>(sql`SELECT id FROM tasks WHERE delivery_id = ${ctx.deliveryId}::uuid
    AND delivery_role IN (SELECT jsonb_array_elements_text(${JSON.stringify(roles)}::jsonb)) AND status IN ('pending', 'assigned', 'in_progress')`)).length;
  switch (d.state) {
    case 'MERGED': case 'SUPERSEDED': case 'ABANDONED': case 'FAILED': return;
    case 'ESCALATED': case 'CLOSED_UNMERGED': case 'APPROVED': case 'BLOCKED_ON_TRUNK': return; // a person, the landing door, the trunk fix
    case 'WORKING': if (!ctx.ownerAlive) fail(s, 'WORKING with the owner attempt ended and no retry queued'); return;
    case 'AWAITING_REVIEW': {
      // A reviewer for THIS round: one left over from a superseded round answers nothing (§8.1).
      const live = await q<{ id: string }>(sql`SELECT t.id FROM tasks t JOIN workflow_review_rounds r ON r.id::text = t.context->>'workflowRoundId'
        WHERE r.delivery_id = ${ctx.deliveryId}::uuid AND r.round = ${d.current_round} AND r.status IN ('queued', 'reviewing')
          AND t.delivery_role = 'review' AND t.status IN ('pending', 'assigned', 'in_progress')`);
      if (!live.length && !(!ctx.enforceKnownGaps && await knownLimbo(ctx, d))) fail(s, `AWAITING_REVIEW with no live reviewer for round ${d.current_round}`);
      return;
    }
    case 'CHANGES_REQUESTED': if (!(await openTasks(['fix']))) fail(s, 'CHANGES_REQUESTED with no fix task queued or running'); return;
    case 'FIXING': case 'REPAIRING': if (!(await openTasks(['fix', 'ci_fix', 'conflict_fix']))) fail(s, `${d.state}(${d.state_reason}) with no attempt task live`); return;
    default:
      if (!ctx.enforceKnownGaps && await knownLimbo(ctx, d)) return;
      fail(s, `limbo: ${d.state}(${d.state_reason}) after settling`);
  }
}

/**
 * Limbo already pinned by a skipped regression case and owned by a fix task,
 * matched narrowly so any other limbo still fails the random runs.
 *  - a6cbd241: the current round's dispatch_review was acked `skipped:superseded`
 *    (a repair started before the drain) and the resume back to AWAITING_REVIEW
 *    owed none, so the round never gets a reviewer.
 *  - 9e27996d: push_recovery restarted at try 1 after an unproven head move, its
 *    follow-up key collided with the first chain's, and nothing is owed again.
 */
async function knownLimbo(ctx: Ctx, d: DeliveryRow): Promise<boolean> {
  if (d.state === 'AWAITING_REVIEW') {
    const rows = await q<{ outcome: string | null }>(sql`SELECT outcome FROM workflow_effects WHERE delivery_id = ${ctx.deliveryId}::uuid
      AND dedupe_key = ${`dispatch_review:${ctx.deliveryId}:${d.current_round}`}`);
    return rows.length === 1 && String(rows[0].outcome ?? '').startsWith('skipped:');
  }
  if (d.state === 'AWAITING_PUSH') {
    // 9e27996d: a head-keyed restart at try 1 whose follow-up collided with the first chain's try 2.
    const rows = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM workflow_effects WHERE delivery_id = ${ctx.deliveryId}::uuid
      AND kind = 'push_recovery' AND dedupe_key LIKE ${`push_recovery:${ctx.deliveryId}:%:head:%`} AND status = 'done' AND outcome LIKE 'ok:retry_%'`);
    return Number(rows[0]?.n ?? 0) > 0;
  }
  return false;
}

/** Replaying every prefix of the facts fed to the kernel changes nothing. */
async function checkReplay(ctx: Ctx): Promise<void> {
  const before = await fingerprint(ctx);
  for (let i = 0; i < ctx.replays.length; i++) {
    ctx.step = `replay#${i}`;
    if (TRACE) process.stderr.write(`[trace] ${ctx.step}: ${ctx.replayLabels[i]}\n`);
    await guardedSeam(ctx, 'replay', ctx.replays[i]);
    const now = await fingerprint(ctx);
    if (now !== before) fail(ctx.step, `replaying fact ${i} (${ctx.replayLabels[i]}) moved the delivery: ${before} → ${now}`);
  }
}

const VERBOSE = process.env.KERNEL_SEQ_VERBOSE === '1';
const TRACE = process.env.KERNEL_SEQ_TRACE === '1';

const RUN_BUDGET_MS = 90_000;

async function runSequence(spec: RunSpec): Promise<string> {
  const ctx = await setup(spec);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A run that stops making progress fails with the step it stopped at, instead of the suite timing out blind.
  const stalled = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InvariantError(`[${ctx.step}] run made no progress in ${RUN_BUDGET_MS / 1000}s`)), RUN_BUDGET_MS); });
  try {
    return await Promise.race([drive(ctx, spec), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

async function drive(ctx: Ctx, spec: RunSpec): Promise<string> {
  try {
    ctx.step = 'setup';
    await checkInvariants(ctx);
    for (let i = 0; i < spec.acts.length; i++) {
      ctx.step = `#${i} ${JSON.stringify(spec.acts[i])}`;
      await step(ctx, spec.acts[i], i);
      await checkInvariants(ctx);
    }
    await settle(ctx);
    await checkLiveness(ctx);
    await checkReplay(ctx);
    if (ctx.surprises.length) fail('errors', `seam calls threw:\n${ctx.surprises.join('\n')}`);
    if (ctx.gh.unsupported.length) fail('fake', `kernel called routes the fake does not model: ${ctx.gh.unsupported.join(', ')}`);
    const d = await delivery(ctx);
    if (VERBOSE) {
      const path = await q<{ command: string; to_state: string }>(sql`SELECT command, to_state FROM workflow_transitions WHERE delivery_id = ${ctx.deliveryId}::uuid ORDER BY to_version`);
      process.stderr.write(`[seq] ${spec.acts.length} acts → ${d.state}(${d.state_reason ?? ''}) v${d.version}: ${path.map((t) => `${t.command}>${t.to_state}`).join(' ')}\n`);
    }
    return d.state;
  } catch (e) {
    if (VERBOSE) {
      const path = await q<{ command: string; to_state: string; evidence: unknown }>(sql`SELECT command, to_state, evidence FROM workflow_transitions WHERE delivery_id = ${ctx.deliveryId}::uuid ORDER BY to_version`);
      const rounds = await q(sql`SELECT round, status, head_sha, verdict, failure_count, reviewer_task_id FROM workflow_review_rounds WHERE delivery_id = ${ctx.deliveryId}::uuid ORDER BY round`);
      const fx = await q(sql`SELECT kind, status, outcome, dedupe_key, last_error FROM workflow_effects WHERE delivery_id = ${ctx.deliveryId}::uuid ORDER BY created_at`);
      const tk = await q(sql`SELECT id, delivery_role, status, context->>'workflowRoundId' AS round FROM tasks WHERE delivery_id = ${ctx.deliveryId}::uuid ORDER BY created_at`);
      process.stderr.write(`[fail] ${String((e as Error).message)}\n${path.map((t) => `  ${t.command}>${t.to_state} ${JSON.stringify(t.evidence).slice(0, 300)}`).join('\n')}\n  rounds ${JSON.stringify(rounds)}\n  effects ${JSON.stringify(fx)}\n  tasks ${JSON.stringify(tk)}\n  trail ${ctx.log.join(' | ')}\n`);
    }
    if (ctx.log.length) (e as Error).message += `\n  trail: ${ctx.log.slice(-12).join(' | ')}`;
    throw e;
  } finally {
    ctx.restoreFetch();
  }
}

// ── Regressions: shrunk failures, by name ───────────────────────────────────

const NO_FAULTS: Faults = {};
const owner = (outcome: Outcome = 'completed'): Act => ({ t: 'ownerEnds', outcome, localOnly: false, retry: false });
export const REGRESSIONS: Array<{ name: string; spec: RunSpec; skip?: string }> = [
  {
    name: 'a repeated reviewer failure report is a duplicate',
    skip: 'T27 counts a repeated report as a new failure: fix task 04a79514',
    spec: { seed: 1, faults: NO_FAULTS, strict: false, enforceKnownGaps: true, acts: [owner(), { t: 'reviewerFails', reason: 'prose_verdict' }] },
  },
  {
    // GitHub still computing mergeability after the push (normal) makes the door's stale `dirty` hint win.
    name: 'a round queued just before a not-needed repair still gets a reviewer',
    skip: 'resumeAfterRepair owes no dispatch for an open round whose dispatch was skipped: fix task a6cbd241',
    spec: { seed: 1, faults: { mergeableUnknownReads: 1 }, strict: false, enforceKnownGaps: true, acts: [owner(), { t: 'foreignPush' }, { t: 'conflictDoor', hint: 'dirty' }] },
  },
  {
    name: 'push recovery still escalates after an unproven head move',
    skip: 'the restarted push_recovery chain collides with the first one and ends: fix task 9e27996d',
    spec: { seed: 1, faults: NO_FAULTS, strict: false, enforceKnownGaps: true, acts: [
      { t: 'ownerEnds', outcome: 'completed', localOnly: true, retry: false }, { t: 'clock' }, { t: 'forcePush' }, { t: 'clock' },
    ] },
  },
  {
    // The check was re-run green before its failure hint arrived; the redelivered hint flaps the delivery again.
    name: 'a stale CI-failure hint does not leave APPROVED while CI is green',
    spec: { seed: 1, faults: NO_FAULTS, strict: false, enforceKnownGaps: true, acts: [owner(), { t: 'ci', ok: false }, { t: 'ci', ok: true }, { t: 'verdict', v: 'approve', oldest: false }] },
  },
];

// ── Suite ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  assertDbConfigured();
  installationId = Math.floor(Math.random() * 1e9) * 1000;
  const [inst] = await q<{ id: string }>(sql`INSERT INTO github_installations (installation_id, account_type, account_login, account_id, access_token, token_expires_at)
    VALUES (${installationId}, 'Organization', 'acme', ${installationId}, 'ghs_fake', now() + interval '1 day') RETURNING id`);
  installationRowId = inst.id;
});
afterAll(() => { onReviewerCreated = async () => {}; });

const RUNS = Number(process.env.KERNEL_SEQ_RUNS ?? 12);
const SEED = process.env.KERNEL_SEQ_SEED ? Number(process.env.KERNEL_SEQ_SEED) : 20261009;

describe('kernel invariants under random event sequences', () => {
  test('a quiet happy path settles (harness smoke)', async () => {
    const end = await runSequence({ seed: 7, faults: NO_FAULTS, strict: false, acts: [
      { t: 'ownerEnds', outcome: 'completed', localOnly: false, retry: false },
      { t: 'ci', ok: true }, { t: 'deliver' },
      { t: 'verdict', v: 'approve', oldest: false }, { t: 'deliver' },
      { t: 'land' }, { t: 'deliver' },
    ] });
    expect(end).toBe('MERGED');
  }, 60_000);

  for (const r of REGRESSIONS) {
    (r.skip ? test.skip : test)(`regression: ${r.name}`, async () => { await runSequence(r.spec); }, 60_000);
  }

  // Debugging aid: KERNEL_SEQ_ONLY='<RunSpec JSON>' runs one spec with the transition trail on stderr.
  if (process.env.KERNEL_SEQ_ONLY) test('KERNEL_SEQ_ONLY', async () => { await runSequence(JSON.parse(process.env.KERNEL_SEQ_ONLY!)); }, 120_000);

  test(`${RUNS} random sequences (seed ${SEED})`, async () => {
    await fc.assert(fc.asyncProperty(runArb, async (spec) => { await runSequence(spec); }), {
      numRuns: RUNS, seed: SEED,
      reporter: (out) => {
        if (!out.failed) return;
        // Console is silenced under tests/setup.ts: everything needed to reproduce goes in the error.
        throw new Error(`seed=${out.seed} path=${out.counterexamplePath} (shrunk ${out.numShrinks}x)\n`
          + `shrunk: ${JSON.stringify(out.counterexample?.[0])}\n`
          + `error: ${String((out.errorInstance as Error)?.message ?? out.errorInstance)}`);
      },
    });
  }, 30 * 60_000);
});


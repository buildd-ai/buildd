/**
 * PR review status — the pure shape of "where is this review right now".
 *
 * Kept free of DB and network access so the same mapping serves the read
 * action, the long-poll loop, and the callback payload, and so callers can be
 * tested without a database. The DB reads and the adoption path live in
 * `pr-review-request.ts`.
 */

import { parseReviewBlockers, type ReviewBlocker } from './attention-line';
import type { DeliveryView } from './workflow/projections';

/** Bound on a single callback delivery. A hanging endpoint must not stall a verdict. */
export const REVIEW_CALLBACK_TIMEOUT_MS = 5_000;

/**
 * Ceiling on server-side long-poll.
 *
 * Vercel's default function duration for this app is 60s and no `maxDuration`
 * is configured, so a long-poll MUST return well before that — a client that
 * gets a `timedOut` response can simply call again, whereas a killed function
 * looks like a network error.
 */
export const MAX_REVIEW_WAIT_SECONDS = 45;

/** How long to sleep between state reads while long-polling. */
export const REVIEW_POLL_INTERVAL_MS = 2_000;

export type PrReviewState =
  | 'not_requested'
  | 'queued'
  | 'reviewing'
  | 'approved'
  | 'changes_requested'
  | 'escalated'
  | 'review_failed';

export type PrReviewVerdict = 'approve' | 'request-changes' | 'escalate';

/** What the caller is waiting for: the reviewer's verdict, or the PR landing. */
export type PrReviewWaitFor = 'verdict' | 'merge';

export interface PrReviewStatus {
  state: PrReviewState;
  /** True when nothing further will change for the caller's {@link PrReviewWaitFor}. */
  terminal: boolean;
  reviewTaskId: string | null;
  /** The task the PR is mapped to — the adopted task for an external PR. */
  adoptedTaskId: string | null;
  verdict: PrReviewVerdict | null;
  confidence: number | null;
  summary: string | null;
  feedback: string | null;
  escalationReason: string | null;
  /** The reviewer's one-line next step for a person (escalate only). */
  recommendation: string | null;
  /** Structured reasons behind an escalation; empty on rows that predate them. */
  blockers: ReviewBlocker[];
  /**
   * Why the review never produced a verdict, when `state === 'review_failed'`.
   * Sourced from the review task's own worker (its `error`/`exitCause`), which
   * is the only place that reason lives — `result`/`context` are empty for a
   * session that crashed before completing. Null for every other state, and
   * null even for `review_failed` if the worker row itself is gone or has no
   * recorded error (an old pre-migration row, for instance).
   */
  failureReason: string | null;
  /**
   * Required findings still open on the delivery. Null for a PR the workflow
   * kernel does not own, which has no finding ledger.
   */
  openFindings: number | null;
  /** Request-changes retry position: the kernel's round, or the reviewer task context. */
  iteration: number | null;
  maxIterations: number | null;
  /**
   * The commit this review round was dispatched against, from the reviewer task
   * context. A verdict is only a statement about the code it read, so this is
   * what lets a caller tell a verdict that still describes the PR from one a
   * later push has superseded — see `review-verdict-gate.ts`.
   */
  reviewHeadSha: string | null;
  /**
   * Later heads an approval was carried to because the PR diff was unchanged
   * (see approval-carry-forward.ts). Empty unless a carry-forward happened.
   */
  reviewEquivalentHeadShas: string[];
  prState: 'open' | 'merged' | 'closed' | 'unknown';
  merged: boolean;
  /** Set when an approved PR will not be merged by buildd. */
  mergeBlocked: 'awaiting_human' | null;
}

/** The slice of a kernel delivery view the review status reads (§7). */
export type DeliveryReviewInput = Pick<
  DeliveryView,
  'state' | 'stateReason' | 'headSha' | 'rounds' | 'attempts' | 'approvedCurrentHead' | 'openFindings' | 'prNumber'
>;

interface DeriveInput {
  /**
   * The PR's kernel delivery. When present it owns state, verdict, round and
   * open findings; `reviewTask` then only supplies the reviewer's prose
   * (confidence, summary, feedback). Absent: the legacy reviewer-task path.
   */
  delivery?: DeliveryReviewInput | null;
  reviewTask?: {
    id: string;
    status: string;
    result?: unknown;
    context?: unknown;
  } | null;
  worker?: {
    taskId: string | null;
    prLifecycleStatus?: string | null;
    mergedAt?: Date | null;
  } | null;
  /** The review task's own worker — distinct from `worker` above (the PR owner). */
  reviewerWorker?: {
    error?: string | null;
    exitCause?: string | null;
  } | null;
  /** Whether the effective merge policy would have buildd merge on approval. */
  autoMergeExpected?: boolean;
  waitFor?: PrReviewWaitFor;
}

/** Human-readable fallback when the reviewer worker has an exitCause but no free-text error. */
const EXIT_CAUSE_LABEL: Record<string, string> = {
  never_started: 'the review worker never started',
  infra_failure: 'the review worker hit an infrastructure failure',
  budget_limited: 'the review worker ran out of budget before producing a verdict',
  silent_start: 'the review worker started but produced no output',
  reassigned: 'the review worker was reassigned before finishing',
  sandbox_mount_gap: 'the review worker could not mount its sandbox',
  server_refused: 'the server refused the review worker',
  task_cancelled: 'the review task was cancelled before a verdict was produced',
};

const DELIVERY_VERDICT: Record<string, PrReviewVerdict> = {
  approve: 'approve',
  request_changes: 'request-changes',
  escalate: 'escalate',
};

/** State, verdict and round position from the delivery's own record, never the reviewer tasks. */
function readDelivery(d: DeliveryReviewInput): {
  state: PrReviewState;
  verdict: PrReviewVerdict | null;
  round: number | null;
  /** Review-fix attempts used so far: the budget's own counter, which a new head's review never moves. */
  fixesUsed: number | null;
  maxRounds: number | null;
  headSha: string | null;
  reviewerTaskId: string | null;
} {
  const live = d.rounds.filter((r) => r.status !== 'superseded');
  const round = live[live.length - 1] ?? null;
  const maxRounds = d.attempts.review_fix?.m ?? null;
  const base = { round: round?.round ?? null, fixesUsed: d.attempts.review_fix?.n ?? null, maxRounds, headSha: round?.headSha ?? d.headSha, reviewerTaskId: round?.reviewerTaskId ?? null };
  const decided = round?.status === 'decided'
    ? DELIVERY_VERDICT[round.effectiveVerdict ?? round.verdict ?? ''] ?? null
    : null;

  // A delivery held for a person is escalated whatever the last round said.
  if (d.state === 'ESCALATED') return { ...base, state: 'escalated', verdict: decided ?? 'escalate' };
  if (!round) {
    return { ...base, state: d.state === 'AWAITING_REVIEW' ? 'queued' : d.approvedCurrentHead ? 'approved' : 'not_requested', verdict: d.approvedCurrentHead ? 'approve' : null };
  }
  if (round.status === 'queued') return { ...base, state: 'queued', verdict: null };
  if (round.status === 'reviewing') return { ...base, state: 'reviewing', verdict: null };
  if (round.status === 'failed') return { ...base, state: 'review_failed', verdict: null };
  if (decided) return { ...base, state: VERDICT_STATE[decided], verdict: decided };
  return { ...base, state: 'review_failed', verdict: null };
}

const VERDICT_STATE: Record<PrReviewVerdict, PrReviewState> = {
  approve: 'approved',
  'request-changes': 'changes_requested',
  escalate: 'escalated',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Map the reviewer task + PR-owning worker onto one status a caller can poll.
 *
 * Pure — every field comes from rows the caller already read, so the same
 * mapping serves the read action, the long-poll loop, and the callback payload.
 */
export function derivePrReviewStatus(input: DeriveInput): PrReviewStatus {
  const { reviewTask, worker, reviewerWorker, delivery, autoMergeExpected = true, waitFor = 'verdict' } = input;

  // A kernel-owned PR's lifecycle is the delivery's, not the worker columns'.
  const lifecycle = delivery
    ? delivery.state === 'MERGED' ? 'merged' : ['SUPERSEDED', 'ABANDONED', 'CLOSED_UNMERGED'].includes(delivery.state) ? 'closed' : null
    : worker?.prLifecycleStatus ?? null;
  const merged = lifecycle === 'merged' || (!delivery && Boolean(worker?.mergedAt));
  const prState: PrReviewStatus['prState'] = merged
    ? 'merged'
    : lifecycle === 'closed'
      ? 'closed'
      : worker || delivery
        ? 'open'
        : 'unknown';

  const ctx = asRecord(reviewTask?.context);
  const result = asRecord(reviewTask?.result);
  const output = asRecord(result.structuredOutput);
  // `effectiveVerdict` wins over the model's own when the server overrode it
  // (enforceServerSideEscalation turns an approve into an escalate when the
  // PR's current file list requires a human). The agent's raw output is left
  // untouched as the audit record, but every consumer of "where does this
  // review stand" must read the verdict that actually applies — otherwise a
  // server-escalated PR reads as `approved` to the self-merge check and to the
  // review-verdict gate, which is the one state neither may get wrong.
  const rawVerdict = stringOrNull(result.effectiveVerdict) ?? stringOrNull(output.verdict);
  const legacyVerdict = rawVerdict && rawVerdict in VERDICT_STATE ? (rawVerdict as PrReviewVerdict) : null;
  const fromDelivery = delivery ? readDelivery(delivery) : null;
  const verdict = fromDelivery ? fromDelivery.verdict : legacyVerdict;

  let state: PrReviewState;
  if (fromDelivery) {
    state = fromDelivery.state;
  } else if (!reviewTask) {
    state = 'not_requested';
  } else if (reviewTask.status === 'pending') {
    state = 'queued';
  } else if (reviewTask.status === 'completed') {
    // A completed review with no structured verdict is a dropped verdict, not
    // an approval — the upstream handler already refuses to infer one.
    state = verdict ? VERDICT_STATE[verdict] : 'review_failed';
  } else if (reviewTask.status === 'failed' || reviewTask.status === 'cancelled') {
    // A blocking verdict that landed before the task failed or was cancelled
    // still stands: review_failed does not block any merge door, so reading
    // such a task as review_failed would quietly drop a request-changes. An
    // approve does NOT carry over — a reviewer that never completed cannot be
    // the approval a self-merge door acts on.
    state = verdict === 'request-changes' || verdict === 'escalate'
      ? VERDICT_STATE[verdict]
      : 'review_failed';
  } else {
    state = 'reviewing';
  }

  const awaitingVerdict = !!fromDelivery && (state === 'queued' || state === 'reviewing');

  const failureReason = state === 'review_failed'
    ? stringOrNull(reviewerWorker?.error)
      ?? (reviewerWorker?.exitCause ? EXIT_CAUSE_LABEL[reviewerWorker.exitCause] ?? null : null)
    : null;

  const verdictReached =
    state === 'approved' || state === 'changes_requested' || state === 'escalated' || state === 'review_failed';
  const prSettled = prState === 'merged' || prState === 'closed';
  const mergeBlocked = state === 'approved' && !merged && !autoMergeExpected ? 'awaiting_human' : null;

  // A settled PR is terminal for either wait mode. Otherwise: a verdict-waiter
  // stops at the verdict; a merge-waiter keeps going through a request-changes
  // retry (which can still land) but stops when nothing can land any more.
  const terminal = prSettled
    ? true
    : waitFor === 'verdict'
      ? verdictReached
      : state === 'escalated' || state === 'review_failed' || mergeBlocked !== null;

  return {
    state,
    terminal,
    reviewTaskId: reviewTask?.id ?? fromDelivery?.reviewerTaskId ?? null,
    adoptedTaskId: worker?.taskId ?? stringOrNull(ctx.originalTaskId),
    verdict,
    // A round in flight has no verdict yet. The reviewer task read here is an
    // older round's, so its words ("the prior approval stands") describe a
    // head that is no longer the PR's: they are not a statement about this one.
    confidence: awaitingVerdict ? null : numberOrNull(output.confidence),
    summary: awaitingVerdict ? null : stringOrNull(output.summary),
    feedback: awaitingVerdict ? null : stringOrNull(output.feedback),
    escalationReason: awaitingVerdict
      ? null
      : stringOrNull(result.effectiveVerdictReason) ?? stringOrNull(output.escalationReason),
    recommendation: awaitingVerdict ? null : stringOrNull(output.recommendation),
    blockers: awaitingVerdict ? [] : parseReviewBlockers(output.blockers),
    failureReason,
    openFindings: delivery ? delivery.openFindings ?? 0 : null,
    // The budget is review-fix attempts, not rounds: every new head (a CI fix,
    // a base merge) opens a round, so "round 11 of 3" was a count of pushes.
    // The round is the budget's position only while changes are being asked for.
    iteration: fromDelivery
      ? verdict === 'request-changes' || verdict === 'escalate' ? fromDelivery.round : fromDelivery.fixesUsed
      : numberOrNull(ctx.iteration),
    maxIterations: fromDelivery ? fromDelivery.maxRounds : numberOrNull(ctx.maxIterations),
    reviewHeadSha: fromDelivery ? fromDelivery.headSha : stringOrNull(ctx.headSha),
    reviewEquivalentHeadShas: Array.isArray(ctx.equivalentHeadShas)
      ? ctx.equivalentHeadShas.filter((s): s is string => typeof s === 'string')
      : [],
    prState,
    merged,
    mergeBlocked,
  };
}

/** Minimal shape needed to decide whether a stored verdict authorises a self-merge. */
export interface SelfMergeApprovalInput {
  verdict: PrReviewVerdict | null;
  confidence: number | null;
  /** Already merged — never re-authorise a merge that already happened. */
  merged?: boolean;
}

/**
 * Whether a stored reviewer verdict, on its own, authorises merging the PR —
 * subject to the SAME diff-safety rails (CI green, legacy stored deny paths, dirty
 * state) that `evaluateAutoMergeSafety` applies when called without a bound.
 *
 * This is the ONE definition of "does this verdict clear the confidence bar":
 * merge_pr's self-merge escape hatch, the check_suite CI-green retry, and the
 * reviewer approve path all call this instead of keeping their own copy of
 * the threshold compare — three copies of this rule is how the confidence
 * check and the "is it already merged" check drifted apart between them.
 */
export function isApprovalSelfMergeable(
  input: SelfMergeApprovalInput,
  maxConfidenceThreshold?: number,
): boolean {
  const threshold = maxConfidenceThreshold ?? 0.6;
  return (
    input.verdict === 'approve' &&
    !input.merged &&
    typeof input.confidence === 'number' &&
    input.confidence >= threshold
  );
}

/** Roles that make sense as a default reviewer, most specific first. */
const REVIEWER_ROLE_PREFERENCE = ['reviewer', 'spec-validator', 'builder'];

/**
 * Task 2ded4e88, for a PR the workflow kernel does not own: the review round budget is spent.
 * The newest review asked for changes at the request-changes cap the reviewer outcome handler
 * escalates on (apps/web/src/app/api/workers/[id]/route.ts: `iteration >= maxIterations`,
 * default 3). A push after that is a person's to judge, not a reason for another round: a
 * re-dispatch inherits the same iteration and escalates again, and the PR ping-pongs.
 */
export function isReviewBudgetSpent(status: Pick<PrReviewStatus, 'verdict' | 'iteration' | 'maxIterations'>): boolean {
  if (status.verdict !== 'request-changes') return false;
  return (status.iteration ?? 0) >= (status.maxIterations ?? 3);
}

/**
 * Choose the role the reviewer agent runs as.
 *
 * An explicitly requested role that the workspace does not have is an error
 * rather than a silent substitution: routing a review to the wrong persona
 * (different model, different tool access) is worse than refusing.
 */
export function pickReviewerRole(params: {
  requested?: string | null;
  policyRole?: string | null;
  available: Array<{ slug: string; isRole?: boolean | null }>;
}): { role: string | null; source?: 'requested' | 'policy' | 'default'; error?: string } {
  const slugs = params.available.filter((r) => r.isRole !== false).map((r) => r.slug);
  if (slugs.length === 0) {
    return { role: null, error: 'Workspace has no roles — register a role before requesting a review.' };
  }

  if (params.requested) {
    if (slugs.includes(params.requested)) return { role: params.requested, source: 'requested' };
    return {
      role: null,
      error: `Role '${params.requested}' does not exist in this workspace. Available: ${slugs.join(', ')}`,
    };
  }

  if (params.policyRole && slugs.includes(params.policyRole)) {
    return { role: params.policyRole, source: 'policy' };
  }

  const preferred = REVIEWER_ROLE_PREFERENCE.find((slug) => slugs.includes(slug));
  return { role: preferred ?? slugs[0]!, source: 'default' };
}

/**
 * Deliver a review status to a caller-supplied callback URL.
 *
 * https only — a verdict carries review feedback about unmerged code, so it is
 * never posted in the clear. Best-effort and bounded: the return value says
 * whether it landed, and no failure ever propagates to the verdict path.
 */
export async function firePrReviewCallback(
  callbackUrl: string,
  payload: PrReviewStatus & { prNumber: number; repoFullName?: string },
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    console.warn(`[pr-review] callback URL is not a URL: ${callbackUrl}`);
    return false;
  }
  if (parsed.protocol !== 'https:') {
    console.warn(`[pr-review] refusing non-https review callback: ${parsed.protocol}//${parsed.host}`);
    return false;
  }

  try {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REVIEW_CALLBACK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[pr-review] callback to ${parsed.host} returned ${res.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      `[pr-review] callback to ${parsed.host} failed:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

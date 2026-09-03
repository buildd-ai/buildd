/**
 * PR review status — the pure shape of "where is this review right now".
 *
 * Kept free of DB and network access so the same mapping serves the read
 * action, the long-poll loop, and the callback payload, and so callers can be
 * tested without a database. The DB reads and the adoption path live in
 * `pr-review-request.ts`.
 */


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
  /** Request-changes retry position, from the reviewer task context. */
  iteration: number | null;
  maxIterations: number | null;
  prState: 'open' | 'merged' | 'closed' | 'unknown';
  merged: boolean;
  /** Set when an approved PR will not be merged by buildd. */
  mergeBlocked: 'awaiting_human' | null;
}

interface DeriveInput {
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
  /** Whether the effective merge policy would have buildd merge on approval. */
  autoMergeExpected?: boolean;
  waitFor?: PrReviewWaitFor;
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
  const { reviewTask, worker, autoMergeExpected = true, waitFor = 'verdict' } = input;

  const lifecycle = worker?.prLifecycleStatus ?? null;
  const merged = lifecycle === 'merged' || Boolean(worker?.mergedAt);
  const prState: PrReviewStatus['prState'] = merged
    ? 'merged'
    : lifecycle === 'closed'
      ? 'closed'
      : worker
        ? 'open'
        : 'unknown';

  const ctx = asRecord(reviewTask?.context);
  const output = asRecord(asRecord(reviewTask?.result).structuredOutput);
  const rawVerdict = stringOrNull(output.verdict);
  const verdict = rawVerdict && rawVerdict in VERDICT_STATE ? (rawVerdict as PrReviewVerdict) : null;

  let state: PrReviewState;
  if (!reviewTask) {
    state = 'not_requested';
  } else if (reviewTask.status === 'pending') {
    state = 'queued';
  } else if (reviewTask.status === 'completed') {
    // A completed review with no structured verdict is a dropped verdict, not
    // an approval — the upstream handler already refuses to infer one.
    state = verdict ? VERDICT_STATE[verdict] : 'review_failed';
  } else if (reviewTask.status === 'failed' || reviewTask.status === 'cancelled') {
    state = 'review_failed';
  } else {
    state = 'reviewing';
  }

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
    reviewTaskId: reviewTask?.id ?? null,
    adoptedTaskId: worker?.taskId ?? stringOrNull(ctx.originalTaskId),
    verdict,
    confidence: numberOrNull(output.confidence),
    summary: stringOrNull(output.summary),
    feedback: stringOrNull(output.feedback),
    escalationReason: stringOrNull(output.escalationReason),
    iteration: numberOrNull(ctx.iteration),
    maxIterations: numberOrNull(ctx.maxIterations),
    prState,
    merged,
    mergeBlocked,
  };
}

/** Roles that make sense as a default reviewer, most specific first. */
const REVIEWER_ROLE_PREFERENCE = ['reviewer', 'spec-validator', 'builder'];

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

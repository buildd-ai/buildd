export type WorkerExitCause =
  | 'code_failure'
  | 'budget_limited'
  | 'infra_failure'
  | 'never_started'
  | 'silent_start'
  | 'reassigned'
  | 'condition_unmet'
  | 'sandbox_mount_gap'
  /**
   * The agent stopped to ask a human a question and nobody answered before
   * the waiting_input timeout — correct behaviour, not a crash. Must never
   * be booked as code_failure; excluded from the failure rate and
   * failure-signature ranking, but still queryable by this exit cause.
   */
  | 'needs_input'
  /**
   * The coordination server REFUSED a mutation from this session — a bad or
   * expired runner credential, a worker row that no longer exists, a malformed
   * payload, a rate limit, a 5xx that could not be queued. It describes the
   * REQUEST, not the work: a fresh attempt against the same broken credential
   * or the same missing row fails identically, so charging a retry spends the
   * budget with no chance of a different outcome — the same argument this file
   * already accepts for never_started/silent_start.
   *
   * Bounded rather than unbounded: the PATCH route routes this through the
   * existing infraRetryCount / MAX_INFRA_RETRIES_PATCH budget, so the exemption
   * cannot become an infinite retry loop.
   */
  | 'server_refused'
  /**
   * A declared output gate (GATE_SLUGS.OUTPUT_REQUIREMENT) refused the
   * completion: the session ran, produced commits or a dirty worktree, and
   * shipped neither a PR nor an artifact.
   *
   * IS charged — this refusal only reaches the runner for a session that ended
   * without the agent ever calling complete_task, and a fresh attempt can
   * plausibly open the PR — but kept out of `code_failure` so a coordination
   * refusal stops being reported as an agent code defect, and so the
   * chargeability decision lives in exactly one place (consumesRetryAttempt).
   */
  | 'output_unmet';

/**
 * Failure strings that mean "the coordination server told the runner to stop",
 * not "the agent's work failed".
 *
 * `Terminated by server` is the runner's fallback text when a PATCH came back
 * with `abort: true` and no stated reason — historically produced by a
 * lost-update miss on the worker-row CAS, which killed healthy sessions ~1s
 * after start. Such a report is an infra event: it must never be filed as a
 * code failure and must never consume a retry attempt.
 */
const CONCURRENCY_CONFLICT_PATTERNS = [
  /terminated by server/i,
  /worker state changed concurrently/i,
];

export function isConcurrencyConflictError(error: string | null | undefined): boolean {
  if (!error) return false;
  return CONCURRENCY_CONFLICT_PATTERNS.some(p => p.test(error));
}

/** Error text for a worker row that the claim route minted but no runner ever started. */
export const NEVER_STARTED_ERROR =
  'Worker was never started by a runner (claimed but no session began) — cleaned up as a bookkeeping artifact, not a task failure';

/** Error text for a session that reached started_at but streamed nothing at all. */
export const SILENT_START_ERROR =
  'Worker started but produced no output (0 assistant turns, $0 spend) — the agent session died before its first real turn; check the runner log for this worker id';

/** Error text for the generic staleness kill (a worker that did real work, then went quiet). */
export const STALE_EXPIRED_ERROR = 'Stale worker expired (no update for 15+ minutes)';

/**
 * A session with at most this many turns and zero spend never really produced
 * anything: turn 1–2 are the SDK init/system exchange, so anything at or below
 * this with $0 cost means no assistant output was ever streamed.
 */
export const SILENT_START_MAX_TURNS = 2;

export function classifyReportedFailure(input: {
  budgetLimited: boolean;
  sandboxMountGap: boolean;
  steeringDelivery?: boolean;
  concurrencyConflict?: boolean;
  /**
   * The report is a "the precondition for doing this work was not met" signal
   * rather than an outcome of the work — today, the runner's sequential-backend
   * enforcement deferral (only one active worker of a given backend per
   * workspace; extras are reported as failed with a `Deferred:` error). The
   * task is re-queued untouched, so it must not consume a retry attempt.
   *
   * This input exists because the caller has to decide it BEFORE classifying:
   * the deferral used to be detected only after `exitCause` had already been
   * written, which booked concurrency control working as designed as a
   * `code_failure` and let repeated deferrals permanently fail a task that was
   * never actually attempted.
   */
  conditionUnmet?: boolean;
  /**
   * The reported error is the `needs_input: <question>` text the AskUserQuestion
   * abort handler writes. A worker in this state should almost always be
   * reported as `waiting_input`, never `failed` — this input exists for the
   * remaining terminal paths (the waiting_input timeout, or any future
   * producer of the same prefix) so they are never silently booked as
   * code_failure.
   */
  needsInput?: boolean;
  /**
   * The runner is reporting that THIS SERVER refused one of its mutations (a
   * 4xx, or a 5xx the outbox could not queue) rather than that the session
   * crashed. A report, not a decision: the runner holds no retry counter, so
   * chargeability is settled here and in consumesRetryAttempt.
   */
  serverRefused?: boolean;
  /**
   * The refusal above carried GATE_SLUGS.OUTPUT_REQUIREMENT — i.e. it was about
   * this session's DELIVERABLES, not about the shape of its request. Strictly
   * narrower than `serverRefused` and checked first.
   */
  outputGateRefused?: boolean;
  /**
   * The runner is reconciling a session its own process lost — on boot it
   * reports every mid-session worker `failed` / `Process restarted` with this
   * flag set. A runner self-update or crash says nothing about the task, so it
   * is an infra failure; left unclassified it fell through to code_failure,
   * and a non-mission task (0 retries) was failed permanently by one restart.
   */
  crashReconciled?: boolean;
}): WorkerExitCause {
  if (input.budgetLimited) return 'budget_limited';
  if (input.sandboxMountGap) return 'sandbox_mount_gap';
  if (input.crashReconciled) return 'infra_failure';
  // Steering-delivery crashes are infra failures — the CLI rejected a malformed
  // invocation, not a code defect. Must not consume a retry attempt.
  if (input.steeringDelivery) return 'infra_failure';
  // Server-side concurrency conflicts are infra failures for the same reason:
  // the session was killed by coordination bookkeeping, not by the work.
  if (input.concurrencyConflict) return 'infra_failure';
  // An output-gate refusal is about the session's DELIVERABLES, so it stays
  // chargeable — but under its own cause rather than code_failure. Checked
  // before serverRefused because both are true for a gate 400 and the gate is
  // the more specific claim.
  if (input.outputGateRefused) return 'output_unmet';
  // Every other refusal is about the REQUEST, not the work.
  if (input.serverRefused) return 'server_refused';
  // A genuine needs_input report should still be filed under a real diagnosed
  // cause above when one is also present — same reasoning as conditionUnmet
  // below, and checked ahead of it because it is the more specific signal.
  if (input.needsInput) return 'needs_input';
  // Deliberately last of the non-default causes: a deferral report carrying a
  // real budget/sandbox/steering signal should still be filed under that
  // signal, which is the diagnosis, not under the scheduling decision.
  if (input.conditionUnmet) return 'condition_unmet';
  return 'code_failure';
}

/**
 * Classify a worker the reaper is about to kill.
 *
 * Before this existed everything the reaper touched was booked as
 * `infra_failure` with "Stale worker expired (no update for 15+ minutes)".
 * That collapsed three very different situations into one undiagnosable
 * bucket (2026-08-28: 31 of 127 weekly failures were $0/≤2-turn rows):
 *
 *   never_started — the row was created at claim but no runner ever started it
 *                   (over-claim: the runner started worker 1 of N and threw
 *                   before the rest). Not an infra failure, a bookkeeping
 *                   artifact; must never consume the task's retry budget.
 *   silent_start  — started_at is set but the session streamed nothing at all.
 *                   Points at the runner/SDK stream, not the task.
 *   infra_failure — the worker did real work and then went offline.
 */
export function classifyStaleExit(worker: {
  startedAt?: Date | string | null;
  turns?: number | null;
  costUsd?: string | number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}): { exitCause: WorkerExitCause; error: string } {
  if (!worker.startedAt) {
    return { exitCause: 'never_started', error: NEVER_STARTED_ERROR };
  }
  if (isSilentStartShape(worker)) {
    return { exitCause: 'silent_start', error: SILENT_START_ERROR };
  }
  return { exitCause: 'infra_failure', error: STALE_EXPIRED_ERROR };
}

/**
 * A session that streamed nothing: at most SILENT_START_MAX_TURNS turns, $0,
 * and no tokens in either direction. Shared by the reaper (classifyStaleExit)
 * and the PATCH route's contract guards, which must not book a session that
 * never produced a turn as the agent breaking its output contract.
 */
export function isSilentStartShape(worker: {
  turns?: number | null;
  costUsd?: string | number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}): boolean {
  const turns = worker.turns ?? 0;
  const rawCost = worker.costUsd;
  const cost = typeof rawCost === 'string' ? parseFloat(rawCost) : (rawCost ?? 0);
  const spent = Number.isFinite(cost) ? cost : 0;
  // costUsd is only ever priced on the terminal PATCH path (see model-prices.ts /
  // PATCH /api/workers/[id]) — the reaper's own kill path never writes it, so
  // "costUsd === 0" is true for every worker it looks at, including ones that
  // burned real tokens on turn 1 or 2. inputTokens/outputTokens ARE live-synced
  // by the runner's periodic progress reports regardless of terminal state, so
  // they are the signal that actually discriminates "did something" from "dead".
  const tokensUsed = (worker.inputTokens ?? 0) > 0 || (worker.outputTokens ?? 0) > 0;
  return turns <= SILENT_START_MAX_TURNS && spent <= 0 && !tokensUsed;
}

/**
 * Exits the taxonomy itself calls bookkeeping rather than failure: a parked
 * question that timed out, a claim no runner ever started, a deferral /
 * unmet loop condition. They stay `failed` rows (and stay searchable by
 * signature), but they are not the workspace failing and must not move its
 * failure rate. infra_failure and silent_start are deliberately NOT here —
 * they are real failures, just not chargeable ones.
 */
export function isBookkeepingExit(exitCause: WorkerExitCause | null | undefined): boolean {
  return exitCause === 'needs_input'
    || exitCause === 'never_started'
    || exitCause === 'condition_unmet';
}

export function consumesRetryAttempt(exitCause: WorkerExitCause | null | undefined): boolean {
  return exitCause !== 'budget_limited'
    && exitCause !== 'infra_failure'
    && exitCause !== 'sandbox_mount_gap'
    && exitCause !== 'condition_unmet'
    // A row no runner ever started, and a session that streamed nothing, say
    // nothing about the task — charging them would burn the retry budget of a
    // task that was never actually attempted.
    && exitCause !== 'never_started'
    && exitCause !== 'silent_start'
    // A parked question that timed out unanswered is not the task's own
    // defect — charging it would burn the retry budget on a task that was
    // never actually attempted at solving the problem, only blocked on it.
    && exitCause !== 'needs_input'
    // A refused REQUEST says nothing about the work — see WorkerExitCause.
    // NOTE: 'output_unmet' is deliberately ABSENT from this list. It IS
    // charged: that refusal is about the session's deliverables, and a fresh
    // attempt can plausibly ship them. If the evidence says otherwise, this is
    // the one line to change.
    && exitCause !== 'server_refused';
}

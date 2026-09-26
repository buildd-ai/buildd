/**
 * What happens to a worker's session when its question is answered.
 *
 * A worker parked on `AskUserQuestion` is a HEALTHY session: nothing failed, it
 * correctly stopped to ask a human. Answering it used to end that session
 * unconditionally and insert a cold `Continue:` task whose entire inheritance
 * was a branch and a description — so a worker hundreds of turns deep lost
 * every judgement it had made, and the continuation re-derived it or quietly
 * undid it.
 *
 * The runner has always been able to resume: `resumeSession` (recovery.ts)
 * routes Claude by session id and Codex by thread id, into the same worktree,
 * which `startSession`'s `finally` block deliberately preserves for a `waiting`
 * worker. The capability was simply never used for the one case where the
 * session ended in perfect health.
 *
 * This module holds the decision — which path an answer takes and why — as a
 * pure function, so it is reproducible from what was recorded and testable
 * without a database. See docs/specs/answered-question-resume.md.
 */

/**
 * How stale `workers.updatedAt` may be and still mean "the runner that holds
 * this worker's transcript and worktree is alive and will drain its queue".
 *
 * The owning runner re-syncs every waiting worker on a 10s cycle and no other
 * runner ever syncs it, so this column is an exact per-worker liveness signal.
 * 9x the cycle, so a handful of dropped syncs does not cost a resume.
 */
export const RESUME_RUNNER_FRESH_MS = 90_000;

/**
 * Turn count above which the platform goes cold DELIBERATELY rather than
 * resume a transcript that may not fit.
 *
 * Turns are a proxy, not a measurement: the server holds no direct read of a
 * parked session's context occupancy (`workers.inputTokens` is cumulative
 * across turns and `workers.resultMeta` is written only at a terminal state,
 * which a parked worker is not). Declaring the proxy and the threshold is the
 * point — the alternative is resuming on luck and discovering the ceiling as a
 * death one turn later.
 */
export const RESUME_MAX_TURNS = 250;

/**
 * How long a queued answer may sit unacknowledged before the platform stops
 * believing the resume happened and degrades to a cold continuation.
 */
export const RESUME_ACK_DEADLINE_MS = 10 * 60 * 1000;

/**
 * The closed set of reasons an answer took the path it took. Closed on purpose:
 * a free-text reason is not queryable, and an unqueryable degradation is the
 * same as an invisible one.
 */
export const ANSWER_PATH_REASONS = {
  resume_eligible:
    'the worker was still parked on a live runner with headroom and a healthy credential',
  worker_not_parked:
    'the worker was no longer parked on its question, so its worktree had already been cleaned up',
  runner_not_holding_transcript:
    'the runner holding this session and its worktree stopped reporting, so the transcript is no longer reachable',
  runner_cannot_confirm_delivery:
    'the runner cannot confirm an answer reached the session, so a resume could not be distinguished from silence',
  context_ceiling:
    'the session was too far along to resume safely inside the model context window',
  credential_unhealthy:
    'the agent credential for this workspace is expired or revoked, so resuming would have died unauthenticated',
  resume_not_acknowledged:
    'the answer was queued for the parked session but never acknowledged before the deadline',
} as const;

export type AnswerPathReason = keyof typeof ANSWER_PATH_REASONS;

export type AnswerPath = 'resume' | 'cold_continuation';

/** Result of the backend credential check taken before choosing a path. */
export type CredentialPreflightState = 'ok' | 'unhealthy' | 'unknown';

export interface AnswerPathInput {
  /** `workers.status` as of the answer. */
  workerStatus: string | null;
  /** `workers.updatedAt` — the owning runner's sync clock. */
  workerUpdatedAt: Date | number | null;
  /** `workers.turns`; null is read as zero, never as over the ceiling. */
  workerTurns: number | null;
  /** `workers.supportsInstructionAck`. */
  supportsInstructionAck: boolean;
  credentialPreflight: CredentialPreflightState;
  /** Injectable clock. Defaults to now. */
  now?: number;
}

export interface AnswerPathDecision {
  path: AnswerPath;
  reasonCode: AnswerPathReason;
  /** Human-readable prose for the same code, from the closed set. */
  reason: string;
}

function cold(reasonCode: Exclude<AnswerPathReason, 'resume_eligible'>): AnswerPathDecision {
  return { path: 'cold_continuation', reasonCode, reason: ANSWER_PATH_REASONS[reasonCode] };
}

function toEpoch(value: Date | number | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide whether an answered question resumes its own session or starts a cold
 * continuation.
 *
 * Gates are evaluated in a FIXED order — most fundamental first — so a worker
 * that fails several reports a stable reason rather than one that depends on
 * evaluation order. A reader comparing two fallbacks is comparing like for like.
 */
export function evaluateAnswerPath(input: AnswerPathInput): AnswerPathDecision {
  const now = input.now ?? Date.now();

  // G1: parked. `/respond` accepts an answer for any status carrying
  // `waitingFor` — that is what keeps the question from being swallowed by a
  // worker that also went `error`. Resume cannot be that lenient: the runner's
  // `finally` block preserves a worktree only for a `waiting` (i.e.
  // `waiting_input`) worker and deletes it on every other exit.
  if (input.workerStatus !== 'waiting_input') return cold('worker_not_parked');

  // G2: the transcript and the worktree are node-local, and the runner holding
  // them is the only one that will ever drain this worker's instruction queue.
  const updatedAt = toEpoch(input.workerUpdatedAt);
  if (updatedAt === null || now - updatedAt > RESUME_RUNNER_FRESH_MS) {
    return cold('runner_not_holding_transcript');
  }

  // G3: without an acknowledgement there is no way to tell a resumed session
  // from an answer that vanished, and the platform does not guess.
  if (!input.supportsInstructionAck) return cold('runner_cannot_confirm_delivery');

  // G4: see RESUME_MAX_TURNS.
  if ((input.workerTurns ?? 0) > RESUME_MAX_TURNS) return cold('context_ceiling');

  // G5: `unknown` means no managed credential row — the account supplies its
  // own key. Reading absence as breakage would send those accounts cold forever.
  if (input.credentialPreflight === 'unhealthy') return cold('credential_unhealthy');

  return {
    path: 'resume',
    reasonCode: 'resume_eligible',
    reason: ANSWER_PATH_REASONS.resume_eligible,
  };
}

/** One owner-facing sentence naming which path ran and, when it degraded, why. */
export function describeAnswerPath(decision: AnswerPathDecision): string {
  return decision.path === 'resume'
    ? 'Resumed the worker’s own session with your answer — it keeps everything it already worked out.'
    : `Started a fresh continuation instead of resuming the original session, because ${decision.reason}.`;
}

/**
 * What gets written to `tasks.context.answerDelivery`. Durable, structured and
 * queryable — the record that makes a fallback visible rather than silent.
 */
export interface AnswerDeliveryRecord {
  path: AnswerPath;
  reasonCode: AnswerPathReason;
  reason: string;
  workerId: string;
  decidedAt: string;
  /** Resume path only: when an unacknowledged answer degrades to cold. */
  ackDeadlineAt?: string;
  /**
   * The question being answered, kept so the deadline sweep can build a
   * continuation description after `waitingFor` has been cleared. Omitted when
   * a sensitive workspace redacted the prompt away.
   */
  question?: string;
}

export function buildAnswerDeliveryRecord(opts: {
  decision: AnswerPathDecision;
  workerId: string;
  question: string | null | undefined;
  now?: number;
}): AnswerDeliveryRecord {
  const now = opts.now ?? Date.now();
  return {
    path: opts.decision.path,
    reasonCode: opts.decision.reasonCode,
    reason: opts.decision.reason,
    workerId: opts.workerId,
    decidedAt: new Date(now).toISOString(),
    ...(opts.decision.path === 'resume'
      ? { ackDeadlineAt: new Date(now + RESUME_ACK_DEADLINE_MS).toISOString() }
      : {}),
    ...(opts.question ? { question: opts.question } : {}),
  };
}

/** A milestone as stored on `workers.milestones`; sensitive workspaces strip `label`. */
type MilestoneLike = { type?: string; label?: string; timestamp?: number };

/**
 * The cold continuation's description: original task, what the parked worker
 * got done, the question and the human's answer, verbatim.
 *
 * Shared by `/respond` and by the unacknowledged-resume sweep so the two cannot
 * drift into describing the same event differently.
 */
export function buildContinuationDescription(opts: {
  taskDescription: string | null | undefined;
  milestones: MilestoneLike[];
  question: string;
  answer: string;
}): string {
  const milestonesText = opts.milestones.length > 0
    ? opts.milestones.map(m => `- ${m.label || m.type || 'activity'}`).join('\n')
    : 'No milestones recorded';

  return [
    '## Original Task',
    opts.taskDescription || '',
    '',
    '## What Was Accomplished',
    milestonesText,
    '',
    '## Question Asked',
    opts.question,
    '',
    '## User Response',
    opts.answer,
  ].join('\n');
}

/**
 * The subset of the answered task a continuation is built from. The narrowed
 * unions mirror `tasks` in packages/core/db/schema.ts — widening them to
 * `string` would compile here and fail at the insert.
 */
export interface ContinuationParentTask {
  id?: string | null;
  title?: string | null;
  description?: string | null;
  missionId?: string | null;
  roleSlug?: string | null;
  mode?: 'execution' | 'planning' | null;
  taskClass?: string | null;
  priority?: number | null;
  outputRequirement?: 'pr_required' | 'artifact_required' | 'none' | 'auto' | null;
  outputSchema?: Record<string, unknown> | null;
  category?: 'bug' | 'feature' | 'refactor' | 'chore' | 'docs' | 'test' | 'infra' | 'design' | 'review' | 'research' | null;
  pathManifest?: string[] | null;
  backend?: 'claude' | 'codex' | null;
  context?: unknown;
}

/**
 * The `Continue:` task a cold fallback inserts.
 *
 * Shared by `POST /api/workers/[id]/respond` and by the
 * unacknowledged-resume sweep, which must produce an identical row — two
 * builders for the same event drift, and the drift is only ever noticed as a
 * continuation that lost a field.
 *
 * Field-by-field decision on what carries over from the original task —
 * deliberate per field, not a blanket copy:
 *
 *  - mode, taskClass: COPY. The continuation's job is the ORIGINAL task's job,
 *    now armed with an answer — not a new kind of task. When mode was
 *    'planning' (the parent's deliverable IS a structured plan, e.g. a mission
 *    organizer cycle that asked a clarifying question mid-decompose), the
 *    continuation still owes that same plan; the SDK's outputFormat constraint
 *    (resolveOutputFormat, keyed on mode) applies identically to it, and the
 *    planning-contract guard's mode==='planning' clause
 *    (apps/web/src/app/api/workers/[id]/route.ts) fires the same way regardless
 *    of scheduleId or creationSource — those only gate the guard's separate
 *    orchestrator-fallback clause, which these continuations never hit since
 *    creationSource here always defaults to 'api' (see below).
 *  - priority, outputRequirement, outputSchema, category, pathManifest,
 *    backend: COPY. None of these describe *how* the task was created — they
 *    describe what it must deliver and how, which does not change because a
 *    question was asked. Dropping outputSchema in particular used to silently
 *    swap a custom contract (e.g. a reviewer verdict schema) for either the
 *    default planning schema or no schema at all. Dropping priority sent a
 *    priority-9 task's continuation to the back of the queue. Dropping
 *    pathManifest lost the conflict-serialization edges against sibling tasks
 *    touching the same files.
 *  - dependsOn: NOT copied. Those edges gated the ORIGINAL task's claim on
 *    prerequisites that were already satisfied before it could run in the first
 *    place — the continuation isn't blocked on them again.
 *  - subjectAnchor: NOT copied. It drives the subject-dedup/supersession gate
 *    for auto-filed tasks (friction/webhook/CI-retry); copying it onto a new
 *    task id under a human-answered flow isn't a case that subsystem is
 *    designed for.
 *  - creationSource: NOT copied (defaults to 'api'). It records who/what
 *    created the row; this row was created by a human or API caller answering a
 *    question, which 'api' describes accurately.
 */
export function buildContinuationTaskValues(opts: {
  task: ContinuationParentTask | null | undefined;
  workspaceId: string;
  workerId: string;
  branch: string | null;
  milestones: MilestoneLike[];
  question: string;
  answer: string;
  delivery: AnswerDeliveryRecord;
}) {
  const parentContext = (opts.task?.context as Record<string, unknown>) || {};
  const currentIteration = (parentContext.iteration as number) || 1;

  return {
    workspaceId: opts.workspaceId,
    title: `Continue: ${opts.task?.title || 'Unknown task'}`,
    description: buildContinuationDescription({
      taskDescription: opts.task?.description,
      milestones: opts.milestones,
      question: opts.question,
      answer: opts.answer,
    }),
    status: 'pending' as const,
    parentTaskId: opts.task?.id ?? undefined,
    missionId: opts.task?.missionId ?? undefined,
    roleSlug: opts.task?.roleSlug ?? undefined,
    mode: opts.task?.mode ?? undefined,
    taskClass: (opts.task?.taskClass ?? 'work') as 'work' | 'attempt' | 'bookkeeping',
    priority: opts.task?.priority ?? undefined,
    outputRequirement: opts.task?.outputRequirement ?? undefined,
    outputSchema: opts.task?.outputSchema ?? undefined,
    category: opts.task?.category ?? undefined,
    pathManifest: opts.task?.pathManifest ?? undefined,
    backend: opts.task?.backend ?? undefined,
    context: {
      // Honored by the runner's worktree setup — but ONLY when `branch` already
      // exists on the remote, i.e. the original worker had already pushed. If
      // the question was asked before anything was pushed (the common case:
      // mid-task, before create_pr), no such branch exists and the runner
      // silently cuts a fresh worktree from the default branch. Nothing here
      // can verify at write time which case applies. This is precisely what
      // falling back costs; the resume path has no such gap.
      baseBranch: opts.branch,
      // Explicit continuity marker (same value; this is what the runner's
      // resume-vs-cut-from-base logic actually keys on — baseBranch alone is
      // ambiguous with a mission-branch task's declared base, which must never
      // be checked out directly).
      resumeBranch: opts.branch,
      userInput: opts.answer,
      previousAttempt: {
        question: opts.question,
        milestones: opts.milestones,
        branch: opts.branch,
        workerId: opts.workerId,
      },
      iteration: currentIteration + 1,
      // Why this answer did NOT resume the original session. Recorded on the
      // continuation itself so a reader of the cold task sees it without
      // reconstructing anything.
      answerDelivery: opts.delivery,
    },
  };
}

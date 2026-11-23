/**
 * Resume in place: a tier or model change on a task with a live agent, and an
 * owner's requeue of it, keep the agent's own session instead of ending it.
 *
 * The run is paused at a safe point (lib/worker-pause.ts), and once it parks
 * the server queues one message on the SAME worker row, which the runner
 * injects into the resumed session. A changed model travels on the runner's
 * resume call: the transcript survives a model switch, only the prompt cache
 * does not. Where nothing can be resumed the task takes a new attempt, as
 * before, and the reason is recorded.
 *
 * Pure rules and wording here; lib/in-place-resume.ts does the writes. See
 * docs/specs/in-place-resume.md.
 */
import { INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';
import { RESUME_RUNNER_FRESH_MS, isParked } from './answer-resume';

/** `tasks.context` key: the resume in place that is under way. Cleared when it settles, and by the next claim. */
export const IN_PLACE_RESUME_KEY = 'inPlaceResume';
/** `tasks.context` key: how each restart or model change ended, newest last. */
export const RESUME_HISTORY_KEY = 'resumeHistory';
export const RESUME_HISTORY_KEEP = 10;

/**
 * How long a requested pause may go unreached before the change stops waiting
 * for it. A pause waits for the running tool to finish, and a full test run or
 * build takes several minutes, so this sits well above those.
 */
export const IN_PLACE_PAUSE_DEADLINE_MS = 20 * 60 * 1000;

export type InPlaceCause = 'model_change' | 'requeue';

export interface InPlaceResumeIntent {
  workerId: string;
  cause: InPlaceCause;
  /** `pausing`: a pause was requested. `resuming`: the resume message is queued. */
  phase: 'pausing' | 'resuming';
  fromTier: string | null;
  fromModel: string | null;
  /** Set when the change carries a model the session should continue on. */
  toTier?: string | null;
  toModel?: string | null;
  requestedAt: string;
  pauseDeadlineAt: string;
}

/** Why a change could not resume in place. Closed, so a fallback is queryable. */
export const NEW_ATTEMPT_REASONS = {
  no_live_worker: 'no agent was working on the task',
  interactive_session: 'the run is a person’s own session, which buildd cannot pause',
  session_not_started: 'the agent had not started its session yet, so there was nothing to resume',
  runner_not_reporting: 'the runner holding the session stopped reporting and nothing was parked',
  runner_cannot_confirm_delivery: 'the runner is too old to confirm a resume',
  permission_prompt: 'the agent was waiting on a permission prompt, which lives only in the running session',
  model_not_resolved: 'the change does not name one model the session could continue on',
  codex_model: 'a Codex session keeps the model it started with',
  pause_refused: 'the run stopped before the pause landed',
  pause_not_reached: 'the agent did not reach a safe point to pause in time',
  resume_not_acknowledged: 'the runner never confirmed the resume',
  runner_ignored_model: 'the runner resumed the session but does not take a model from buildd',
} as const;
export type NewAttemptReason = keyof typeof NEW_ATTEMPT_REASONS;

export type InPlacePlan =
  | { kind: 'in_place'; step: 'pause' | 'resume_now' }
  | { kind: 'new_attempt'; reasonCode: NewAttemptReason; reason: string };

export interface PlanWorker {
  status: string;
  runner?: string | null;
  waitingFor?: unknown;
  updatedAt?: Date | number | string | null;
  parkedUntil?: Date | number | null;
  supportsInstructionAck?: boolean | null;
}

const fallback = (reasonCode: NewAttemptReason): InPlacePlan =>
  ({ kind: 'new_attempt', reasonCode, reason: NEW_ATTEMPT_REASONS[reasonCode] });

function epoch(v: Date | number | string | null | undefined): number | null {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : Number(v);
  return Number.isFinite(ms) ? ms : null;
}

/** A fallback plan for a rule the caller checks itself (the task's backend, an unresolved model). */
export const newAttemptPlan = fallback;

/**
 * Can this worker's session be kept? Checked in a fixed order so a worker that
 * fails several rules always reports the same reason.
 */
export function planInPlaceResume(worker: PlanWorker | null | undefined, now: number = Date.now()): InPlacePlan {
  if (!worker) return fallback('no_live_worker');
  if (worker.runner === INTERACTIVE_WORKER_RUNNER) return fallback('interactive_session');
  if (worker.status !== 'running' && worker.status !== 'waiting_input') return fallback('session_not_started');
  // The session and worktree are on the runner's disk, or in a park bundle.
  const updatedAt = epoch(worker.updatedAt);
  const held = isParked(worker.parkedUntil, now) || (updatedAt !== null && now - updatedAt <= RESUME_RUNNER_FRESH_MS);
  if (!held) return fallback('runner_not_reporting');
  if (!worker.supportsInstructionAck) return fallback('runner_cannot_confirm_delivery');
  if (worker.status === 'running') return { kind: 'in_place', step: 'pause' };
  const waitingType = (worker.waitingFor as { type?: unknown } | null | undefined)?.type;
  if (waitingType === 'permission') return fallback('permission_prompt');
  // waiting_input with nothing open: an answer is already queued and the
  // session is about to resume by itself. Queue behind it.
  return { kind: 'in_place', step: 'resume_now' };
}

/** `old → new`, or whichever side is known. */
export function modelSwitchLabel(from: string | null | undefined, to: string | null | undefined): string {
  if (from && to) return from === to ? to : `${from} → ${to}`;
  return to ?? from ?? '';
}

/** The first turn a session resumed in place reads. */
export function inPlaceResumeMessage(intent: Pick<InPlaceResumeIntent, 'cause' | 'fromModel' | 'toModel'>): string {
  const switched = intent.toModel && intent.toModel !== intent.fromModel
    ? ` You now run on ${intent.toModel}${intent.fromModel ? ` (before: ${intent.fromModel})` : ''}.`
    : '';
  const why = intent.cause === 'requeue'
    ? 'The task owner restarted this task. buildd paused you and resumed you in the same session, so everything you read and worked out is kept.'
    : 'The task owner changed the model for this task. buildd paused you and resumed you in the same session, so everything you read and worked out is kept.';
  return `${why}${switched} Carry on with your task from where you stopped. ` +
    'If you were waiting on an answer to a question, it was not answered: take your recommended option, or ask again if you cannot go on without it.';
}

export type ResumeOutcomeKind = 'resumed_in_place' | 'new_attempt';

export interface ResumeHistoryEntry {
  kind: ResumeOutcomeKind;
  cause: InPlaceCause;
  /** The attempt it happened to. */
  workerId: string | null;
  fromModel: string | null;
  toModel: string | null;
  fromTier: string | null;
  toTier: string | null;
  /** new_attempt only. */
  reasonCode?: NewAttemptReason;
  reason?: string;
  at: string;
}

export function resumeHistoryOf(context: unknown): ResumeHistoryEntry[] {
  const list = (context as Record<string, unknown> | null | undefined)?.[RESUME_HISTORY_KEY];
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is ResumeHistoryEntry =>
    !!e && typeof e === 'object' && ((e as ResumeHistoryEntry).kind === 'resumed_in_place' || (e as ResumeHistoryEntry).kind === 'new_attempt'));
}

export function appendResumeHistory(context: unknown, entry: ResumeHistoryEntry): ResumeHistoryEntry[] {
  return [...resumeHistoryOf(context), entry].slice(-RESUME_HISTORY_KEEP);
}

export function readInPlaceResume(context: unknown): InPlaceResumeIntent | null {
  const raw = (context as Record<string, unknown> | null | undefined)?.[IN_PLACE_RESUME_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as InPlaceResumeIntent;
  if (typeof r.workerId !== 'string' || (r.phase !== 'pausing' && r.phase !== 'resuming')) return null;
  if (r.cause !== 'model_change' && r.cause !== 'requeue') return null;
  return r;
}

export function buildInPlaceResumeIntent(opts: {
  workerId: string;
  cause: InPlaceCause;
  phase: InPlaceResumeIntent['phase'];
  fromTier: string | null;
  fromModel: string | null;
  toTier?: string | null;
  toModel?: string | null;
  now?: number;
}): InPlaceResumeIntent {
  const now = opts.now ?? Date.now();
  return {
    workerId: opts.workerId,
    cause: opts.cause,
    phase: opts.phase,
    fromTier: opts.fromTier,
    fromModel: opts.fromModel,
    ...(opts.toModel ? { toModel: opts.toModel, toTier: opts.toTier ?? null } : {}),
    requestedAt: new Date(now).toISOString(),
    pauseDeadlineAt: new Date(now + IN_PLACE_PAUSE_DEADLINE_MS).toISOString(),
  };
}

/** One sentence for the tool result, the task activity and the task page. */
export function describeResumeOutcome(entry: Pick<ResumeHistoryEntry, 'kind' | 'cause' | 'fromModel' | 'toModel' | 'reason'>): string {
  const models = entry.toModel && entry.toModel !== entry.fromModel ? modelSwitchLabel(entry.fromModel, entry.toModel) : '';
  if (entry.kind === 'resumed_in_place') {
    return models
      ? `Resumed in place on ${models}: the same session, with everything it had read and worked out.`
      : 'Resumed in place: the same session, with everything it had read and worked out.';
  }
  const because = entry.reason ? `, because ${entry.reason}` : '';
  return entry.cause === 'requeue'
    ? `New attempt: the task starts again from its last pushed commit${because}.`
    : `New attempt: ${entry.toModel ? `${entry.toModel} applies` : 'the change applies'} from the next attempt and the current run keeps its model${because}.`;
}

/** What is under way, while the pause or the resume has not settled yet. */
export function describeResumeInProgress(intent: InPlaceResumeIntent): string {
  const to = intent.toModel && intent.toModel !== intent.fromModel ? ` on ${modelSwitchLabel(intent.fromModel, intent.toModel)}` : '';
  return intent.phase === 'pausing'
    ? `Pausing the agent at its next safe point, then resuming the same session${to}.`
    : `Resuming the same session${to}.`;
}

/** The task-page line for one attempt: the newest outcome recorded against it. */
export function resumeLineFor(context: unknown, workerId: string): { kind: ResumeOutcomeKind; text: string } | null {
  const entry = resumeHistoryOf(context).filter(e => e.workerId === workerId).at(-1);
  return entry ? { kind: entry.kind, text: describeResumeOutcome(entry) } : null;
}

/**
 * A new claim starts a new attempt, so an intent still on the task did not
 * resume anything. Drop it and record why, on the context the claim writes.
 */
export function settleInPlaceResumeAtClaim(context: Record<string, unknown>, now: number = Date.now()): void {
  const intent = readInPlaceResume(context);
  delete context[IN_PLACE_RESUME_KEY];
  if (!intent) return;
  const reasonCode: NewAttemptReason = intent.phase === 'pausing' ? 'pause_refused' : 'resume_not_acknowledged';
  context[RESUME_HISTORY_KEY] = appendResumeHistory(context, {
    kind: 'new_attempt', cause: intent.cause, workerId: intent.workerId,
    fromModel: intent.fromModel, toModel: intent.toModel ?? null, fromTier: intent.fromTier, toTier: intent.toTier ?? null,
    reasonCode, reason: NEW_ATTEMPT_REASONS[reasonCode], at: new Date(now).toISOString(),
  });
}

/** Record a fallback: the change or restart took (or will take) a new attempt. */
export function newAttemptEntry(opts: {
  cause: ResumeHistoryEntry['cause'];
  workerId: string | null;
  reasonCode: NewAttemptReason;
  fromModel?: string | null; toModel?: string | null; fromTier?: string | null; toTier?: string | null;
  now?: number;
}): ResumeHistoryEntry {
  return {
    kind: 'new_attempt', cause: opts.cause, workerId: opts.workerId,
    fromModel: opts.fromModel ?? null, toModel: opts.toModel ?? null, fromTier: opts.fromTier ?? null, toTier: opts.toTier ?? null,
    reasonCode: opts.reasonCode, reason: NEW_ATTEMPT_REASONS[opts.reasonCode],
    at: new Date(opts.now ?? Date.now()).toISOString(),
  };
}


/**
 * Question gate: the pure half.
 *
 * Before an agent's question reaches a person, the team's decision model
 * (Jev) answers one fixed-label check: could someone with no context act on
 * this question as written? `needs_context` at or above the threshold means
 * the question is not parked and nobody is notified; the agent gets a short
 * pushback naming what to add (./question-brief.ts `questionPushbackText`)
 * and asks again.
 *
 * Shipped as an opt-in, removable experiment of kind `question_gate`, off
 * unless a team runs one (manage_experiments / Settings). Arms, onto the
 * registry's `control | treatment` columns:
 *   - `control`   = shadow: the check runs and is recorded, every question is sent.
 *   - `treatment` = gated: a confident `needs_context` pushes the question back.
 *
 * **The unit is the task.** Pushbacks change how one agent asks; drawing per
 * question would mix arms inside one conversation. The draw is deterministic
 * on the task id, so nothing has to be stored to keep a task in its arm.
 *
 * Invariants the source half keeps:
 * - **Never blocks the agent indefinitely.** At most `maxPushbacks` per worker
 *   (default 2), then the question is sent as-is.
 * - **Fails open.** No experiment, a sensitive workspace, no decision key, a
 *   timeout or any error: the question is sent unchanged.
 *
 * Removing it: conclude the experiment (questions flow as before), then
 * delete this file, ./question-gate-source.ts, the question-check route and
 * the runner's `question_gate` feature. Nothing else reads them.
 */
import { choice, defineDecision, type DecisionRun } from '@builddai/ai-kit/decide';
import { assignExperimentArm } from './experiment-randomizer';
import { clampContext, type BriefedQuestion } from './question-brief';

export const QUESTION_GATE_EXPERIMENT_KIND = 'question_gate' as const;

/** The claim-request `runnerFeatures` entry of a runner that routes questions through the gate. */
export const QUESTION_GATE_RUNNER_FEATURE = 'question_gate';

export type QuestionGateArm = 'control' | 'treatment';

/**
 * Unmeasured. Conservative on purpose: a wrong pushback costs the agent one
 * rewrite, a wrong pass costs nothing new. Re-tune from the readout.
 */
export const DEFAULT_QUESTION_GATE_MIN_CONFIDENCE = 0.7;
export const DEFAULT_QUESTION_GATE_MAX_PUSHBACKS = 2;
export const DEFAULT_QUESTION_GATE_MIN_SAMPLE_PER_ARM = 20;

/** Server-side decision deadline. The runner aborts its request at QUESTION_GATE_RUNNER_TIMEOUT_MS. */
export const QUESTION_GATE_DECISION_TIMEOUT_MS = 3_000;
export const QUESTION_GATE_RUNNER_TIMEOUT_MS = 4_500;

export const QUESTION_GATE_PROMPT_VERSION = 'qg1';

export interface QuestionGateExperimentRow {
  id: string;
  kind: string;
  status: string;
  treatmentFraction: number | string | null;
  policyVersion: number;
  config: unknown;
}

export interface QuestionGateConfig {
  /** A `needs_context` at or above this confidence pushes back (treatment arm only). */
  minConfidence: number;
  /** Pushbacks per worker before a question is sent as-is. */
  maxPushbacks: number;
  minSamplePerArm: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Parse `experiments.config`; every field falls back to its default, never throws. */
export function parseQuestionGateConfig(raw: unknown): QuestionGateConfig {
  const cfg = asRecord(raw);
  const c = cfg.minConfidence;
  const p = cfg.maxPushbacks;
  const m = cfg.minSamplePerArm;
  return {
    // Below 0.5 a `needs_context` is not even the model's own majority view.
    minConfidence: typeof c === 'number' && c >= 0.5 && c <= 1 ? c : DEFAULT_QUESTION_GATE_MIN_CONFIDENCE,
    // Capped at 3: past that the agent is being blocked, not helped.
    maxPushbacks: typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 3 ? p : DEFAULT_QUESTION_GATE_MAX_PUSHBACKS,
    minSamplePerArm: typeof m === 'number' && Number.isInteger(m) && m > 0 ? m : DEFAULT_QUESTION_GATE_MIN_SAMPLE_PER_ARM,
  };
}

/** The config a new question_gate experiment gets when the caller sends none. */
export function defaultQuestionGateConfig(): Record<string, unknown> {
  return {
    arms: { control: 'shadow', treatment: 'push_back_on_confident_needs_context' },
    minConfidence: DEFAULT_QUESTION_GATE_MIN_CONFIDENCE,
    maxPushbacks: DEFAULT_QUESTION_GATE_MAX_PUSHBACKS,
    minSamplePerArm: DEFAULT_QUESTION_GATE_MIN_SAMPLE_PER_ARM,
  };
}

export interface QuestionGateArmDecision extends QuestionGateConfig {
  experimentId: string;
  policyVersion: number;
  arm: QuestionGateArm;
  propensity: number;
  /** Whether a confident `needs_context` may push the question back. */
  apply: boolean;
}

/** The task's arm. Pure and deterministic on (experiment, version, task). */
export function decideQuestionGateArm(experiment: QuestionGateExperimentRow, taskId: string): QuestionGateArmDecision {
  const a = assignExperimentArm<QuestionGateArm>({
    experimentId: experiment.id,
    policyVersion: String(experiment.policyVersion),
    controlArm: 'control',
    treatmentArm: 'treatment',
    unitId: taskId,
    fraction: experiment.treatmentFraction,
  });
  return {
    experimentId: experiment.id,
    policyVersion: experiment.policyVersion,
    arm: a.arm,
    propensity: a.propensity,
    apply: a.arm === 'treatment',
    ...parseQuestionGateConfig(experiment.config),
  };
}

// ── The decision ─────────────────────────────────────────────────────────────

export const QUESTION_GATE_QUESTIONS = {
  verdict: choice(
    {
      question: 'An AI agent working on a software task wants to stop and ask a person the question below. The person has not seen the task, the code or the conversation, and reads it on a phone. Could they choose an answer in a few seconds from what is written here alone?',
      rule: 'Judge only what is written in `question`. Fields that are null were not given. Follow the definitions; when your impression and a definition conflict, the definition wins.',
    },
    {
      actionable: 'A reader with no other context could decide: it says what is being decided and where (the task or the part of the product), and the options say, or plainly imply, what each one leads to. A recommended default helps but is not required. Not for a question that names code, variables or settings without saying what they are for or what changes.',
      needs_context: 'A reader with no context could not decide: the question assumes knowledge of the task or the code, names identifiers or choices without saying what they affect, or the options are bare labels whose consequences are unclear. Example: "Should isWeekend use local time or UTC?" with options "local time" and "UTC". Not for a question whose framing and options already say what is decided and what each choice changes.',
    },
  ),
};

export const QUESTION_GATE_DECISION = defineDecision({
  id: 'buildd.question_gate',
  promptVersion: QUESTION_GATE_PROMPT_VERSION,
  questions: QUESTION_GATE_QUESTIONS,
  mode: 'gated',
  minConfidence: DEFAULT_QUESTION_GATE_MIN_CONFIDENCE,
  timeoutMs: QUESTION_GATE_DECISION_TIMEOUT_MS,
});

export type QuestionGateLabel = 'actionable' | 'needs_context';

/** The record the model reads: the question as the person would see it, plus the task title. */
export function buildQuestionGateState(q: BriefedQuestion, taskTitle: string | null): Record<string, unknown> {
  const options = (q.options ?? []).map(o => typeof o === 'string'
    ? { label: o, leadsTo: null }
    : { label: o.label, leadsTo: o.consequence ?? o.description ?? null });
  return {
    question: {
      task: taskTitle ?? q.where?.taskTitle ?? null,
      context: q.context ?? null,
      asks: q.prompt,
      options,
      recommended: q.recommended ? { option: q.recommended.label, why: q.recommended.reason ?? null } : null,
    },
  };
}

// ── Request / reply ──────────────────────────────────────────────────────────

export interface QuestionGateRequest {
  question: BriefedQuestion;
  /** Pushbacks this worker already received (runner-counted). */
  priorPushbacks: number;
}

const PROMPT_MAX = 1_000;
const LABEL_MAX = 200;
const LINE_MAX = 300;
const OPTIONS_MAX = 12;

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** Validate the runner's body field by field. Unknown fields are dropped. */
export function parseQuestionGateRequest(body: unknown): { ok: true; value: QuestionGateRequest } | { ok: false; error: string } {
  const b = asRecord(body);
  const q = asRecord(b.question);
  const prompt = str(q.prompt, PROMPT_MAX);
  if (!prompt) return { ok: false, error: 'question.prompt is required' };
  const prior = b.priorPushbacks;
  if (prior !== undefined && !(typeof prior === 'number' && Number.isInteger(prior) && prior >= 0)) {
    return { ok: false, error: 'priorPushbacks must be a non-negative integer' };
  }
  const options: NonNullable<BriefedQuestion['options']> = [];
  if (Array.isArray(q.options)) {
    for (const raw of q.options.slice(0, OPTIONS_MAX)) {
      if (typeof raw === 'string') {
        const label = str(raw, LABEL_MAX);
        if (label) options.push(label);
        continue;
      }
      const o = asRecord(raw);
      const label = str(o.label, LABEL_MAX);
      if (!label) continue;
      const consequence = str(o.consequence, LINE_MAX);
      const description = str(o.description, LINE_MAX);
      options.push({
        label,
        ...(consequence ? { consequence } : {}),
        ...(description ? { description } : {}),
        ...(o.recommended === true ? { recommended: true } : {}),
      });
    }
  }
  const context = clampContext(q.context);
  const rec = asRecord(q.recommended);
  const recLabel = str(rec.label, LABEL_MAX);
  const recReason = str(rec.reason, LINE_MAX);
  const where = asRecord(q.where);
  const taskTitle = str(where.taskTitle, LABEL_MAX);
  return {
    ok: true,
    value: {
      priorPushbacks: typeof prior === 'number' ? prior : 0,
      question: {
        prompt,
        options,
        ...(context ? { context } : {}),
        ...(recLabel ? { recommended: { label: recLabel, ...(recReason ? { reason: recReason } : {}) } } : {}),
        ...(taskTitle ? { where: { taskTitle } } : {}),
      },
    },
  };
}

/**
 * What happened to one question. Recorded per check; the readout compares
 * arms on these.
 *  - `actionable`: the model said it is fine (or not confidently otherwise).
 *  - `pushback`: treatment arm, confident `needs_context`; not sent.
 *  - `shadow_needs_context`: control arm, would have been pushed back; sent.
 *  - `max_pushbacks`: this worker already had its pushbacks; sent as-is, no model call.
 *  - `sensitive`: the workspace never sends text out; sent, no model call.
 *  - `error`: the decision failed (no key, timeout, transport); sent (fail open).
 *  - `off`: the team runs no question_gate experiment; sent, nothing recorded.
 */
export type QuestionGateOutcome = 'actionable' | 'pushback' | 'shadow_needs_context' | 'max_pushbacks' | 'sensitive' | 'error' | 'off';

export interface QuestionGateReply {
  verdict: 'send' | 'pushback';
  outcome: QuestionGateOutcome;
  /** Pushback text for the agent; present only with `verdict: 'pushback'`. */
  reason?: string;
  label?: QuestionGateLabel;
  confidence?: number;
  arm?: QuestionGateArm;
  error?: string;
  version: string | null;
  latencyMs: number;
}

/**
 * The gate itself, on a decision's label and confidence. Pure: the arm, the
 * threshold and the pushback count decide; null means the decision failed.
 */
export function gateQuestion(
  answer: { label: QuestionGateLabel; confidence: number } | null,
  arm: Pick<QuestionGateArmDecision, 'apply' | 'minConfidence'>,
): { verdict: 'send' | 'pushback'; outcome: QuestionGateOutcome } {
  if (!answer) return { verdict: 'send', outcome: 'error' };
  const confidentNeedsContext = answer.label === 'needs_context' && answer.confidence >= arm.minConfidence;
  if (!confidentNeedsContext) return { verdict: 'send', outcome: 'actionable' };
  return arm.apply ? { verdict: 'pushback', outcome: 'pushback' } : { verdict: 'send', outcome: 'shadow_needs_context' };
}

/** The label and confidence of a run, whatever the definition's own gate said; null on failure. */
export function readQuestionGateRun(run: DecisionRun<typeof QUESTION_GATE_QUESTIONS>): { label: QuestionGateLabel; confidence: number } | null | { error: string } {
  const outcome = run.outcomes.verdict;
  if (!run.ok || !outcome || outcome.status === 'skipped') {
    return { error: !run.result.ok ? run.result.error.kind : 'no_answer' };
  }
  return { label: outcome.value as QuestionGateLabel, confidence: outcome.confidence };
}

/** One check, as recorded on the task's experiment assignment. Content-free. */
export interface QuestionGateCheckRecord {
  at: string;
  workerId: string;
  outcome: QuestionGateOutcome;
  label: QuestionGateLabel | null;
  confidence: number | null;
  priorPushbacks: number;
  /** Which brief parts the question carried (booleans only). */
  brief: { context: boolean; consequences: boolean; recommended: boolean };
  version: string | null;
  latencyMs: number;
  error?: string;
}

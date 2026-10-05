/**
 * Question gate: the pure half.
 *
 * Before an agent's question reaches a person, two checks run, unconditionally,
 * for every workspace (the one-time kill switch — `WorkspaceGitConfig.jevQuestionGate
 * === false` — is the only off switch; see docs/design/human-question-gate.md and
 * docs/specs/human-in-the-loop-protocol.md):
 *
 *  1. **Brief check.** The team's decision model (Jev) answers one fixed-label
 *     check: could someone with no context act on this question as written?
 *     `needs_context` at or above `DEFAULT_QUESTION_GATE_MIN_CONFIDENCE` means
 *     the question is not parked and nobody is notified; the agent gets a short
 *     pushback naming what to add (./question-brief.ts `questionPushbackText`)
 *     and asks again, up to `DEFAULT_QUESTION_GATE_MAX_PUSHBACKS` times per
 *     worker, then it is sent as-is.
 *  2. **Decide / hold / ask.** Once a question clears the brief check (or the
 *     pushback cap is spent), and no hard rail applies (`detectHardRail`
 *     below), Jev decides: pick one of the listed options itself (the agent
 *     continues immediately, nobody is parked or notified), hold it (parked
 *     like `ask`, but nobody is notified until `HOLD_RESURFACE_MS` passes with
 *     it still unanswered), or ask a person (parked and
 *     notified, unchanged from before this file existed).
 *
 * This used to be an opt-in, removable experiment (`question_gate`). It no
 * longer is: PR #3388's experiment plumbing (the claim-time arm draw, the
 * control/shadow branch, the per-task `experiment_assignments` row) is gone —
 * every workspace gets the same unconditional behaviour, logged to
 * `decision_records` (`packages/core/decision-ledger.ts`) like any other Jev
 * decision, not to an experiment. `QUESTION_GATE_EXPERIMENT_KIND` and
 * `defaultQuestionGateConfig` stay only because `apps/web/src/lib/experiments.ts`
 * still validates (now purely historical/inert) `question_gate` experiment rows.
 *
 * Invariants:
 * - **Never blocks the agent indefinitely.** At most `maxPushbacks` per worker,
 *   then the question is sent as-is.
 * - **Fails open.** A failed decision call, a hard rail, or the kill switch
 *   being off all mean the question reaches a person, exactly as before this
 *   mission.
 */
import { createHash } from 'node:crypto';
import { clampContext, type BriefedQuestion } from './question-brief';

// The decision definitions (questions, the `defineDecision` calls, the run
// readers and the state the model reads) live in ./question-gate-decision.ts,
// which is server-only. This module is the wire contract the runner imports:
// types, constants, request parsing and the pure gate/rail logic.

export const QUESTION_GATE_EXPERIMENT_KIND = 'question_gate' as const;

/** The claim-request `runnerFeatures` entry of a runner that routes questions through the gate. */
export const QUESTION_GATE_RUNNER_FEATURE = 'question_gate';

/**
 * Unmeasured. Conservative on purpose: a wrong pushback costs the agent one
 * rewrite, a wrong pass costs nothing new. Re-tune from the decision ledger.
 * Reused as-is for the decide/hold/ask confidence gate below — one shared,
 * conservative threshold rather than a second untuned number.
 */
export const DEFAULT_QUESTION_GATE_MIN_CONFIDENCE = 0.7;
export const DEFAULT_QUESTION_GATE_MAX_PUSHBACKS = 2;
export const DEFAULT_QUESTION_GATE_MIN_SAMPLE_PER_ARM = 20;

/** Server-side decision deadline. The runner aborts its request at QUESTION_GATE_RUNNER_TIMEOUT_MS. */
export const QUESTION_GATE_DECISION_TIMEOUT_MS = 3_000;
export const QUESTION_GATE_RUNNER_TIMEOUT_MS = 4_500;

export const QUESTION_GATE_PROMPT_VERSION = 'qg1';

/** @deprecated Historical shape, kept only so a pre-mission `question_gate` experiment row still parses. */
export interface QuestionGateExperimentRow {
  id: string;
  kind: string;
  status: string;
  treatmentFraction: number | string | null;
  policyVersion: number;
  config: unknown;
}

export interface QuestionGateConfig {
  /** A `needs_context` at or above this confidence pushes back. */
  minConfidence: number;
  /** Pushbacks per worker before a question is sent as-is. */
  maxPushbacks: number;
  minSamplePerArm: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Parse a legacy `question_gate` experiment's `config`; every field falls
 * back to its default, never throws. The gate itself no longer reads an
 * experiment row — this stays only because `experiments.ts` still validates
 * one at creation time for teams that still have one on record.
 */
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

/** The config a legacy `question_gate` experiment gets when the caller sends none. */
export function defaultQuestionGateConfig(): Record<string, unknown> {
  return {
    arms: { control: 'shadow', treatment: 'push_back_on_confident_needs_context' },
    minConfidence: DEFAULT_QUESTION_GATE_MIN_CONFIDENCE,
    maxPushbacks: DEFAULT_QUESTION_GATE_MAX_PUSHBACKS,
    minSamplePerArm: DEFAULT_QUESTION_GATE_MIN_SAMPLE_PER_ARM,
  };
}

// ── Stage 1: the brief check ─────────────────────────────────────────────────

export type QuestionGateLabel = 'actionable' | 'needs_context';

/**
 * The stage-1 gate itself, on a decision's label and confidence. Pure: the
 * threshold decides; null means the decision failed (fail open).
 */
export function gateQuestion(
  answer: { label: QuestionGateLabel; confidence: number } | null,
  minConfidence: number,
): { verdict: 'send' | 'pushback'; outcome: QuestionGateOutcome } {
  if (!answer) return { verdict: 'send', outcome: 'error' };
  const confidentNeedsContext = answer.label === 'needs_context' && answer.confidence >= minConfidence;
  return confidentNeedsContext ? { verdict: 'pushback', outcome: 'pushback' } : { verdict: 'send', outcome: 'actionable' };
}

// ── Stage 2: decide / hold / ask ─────────────────────────────────────────────

export type QuestionDisposition = 'decide' | 'hold' | 'ask';

/**
 * The five hard rails (docs/design/human-question-gate.md "Deterministic
 * rails"): decide (and hold) are unavailable the moment one of these applies —
 * the question always goes to a person, with the full brief, exactly as it did
 * before this mission.
 *
 *  - `migration`: the task's pathManifest touches the workspace's
 *    `destructive_schema_change` risk-class paths (policyConfig), or the
 *    hardcoded default (`packages/core/db/schema.ts`, `packages/core/drizzle/`)
 *    when the workspace has not run a policy scan.
 *  - `auth_secrets`: pathManifest touches `auth_and_secrets` risk-class paths
 *    (default: `apps/web/src/app/api/secrets/`, `packages/core/secrets/`).
 *  - `ci_deploy`: pathManifest touches `ci_deploy_config` risk-class paths
 *    (default: `.github/workflows/`, `docker/worker/Dockerfile`, `vercel.json`).
 *  - `protected_path`: pathManifest touches a path the WORKSPACE itself
 *    declared sensitive (merge policy deny/escalate paths) beyond the three
 *    universal classes above.
 *  - `spending`: the one rail with no structured signal on a task — there is
 *    no "this question is about money" field anywhere today. Detected from the
 *    question's own visible text (a dollar amount, or a small set of
 *    spend-shaped words). This is a deliberately conservative heuristic, not a
 *    lookup: it can miss a real spending question dressed in different words,
 *    but a false positive only costs one extra `ask`.
 */
export type HardRailKind = 'migration' | 'auth_secrets' | 'ci_deploy' | 'protected_path' | 'spending';

const DEFAULT_SCHEMA_PATHS = ['packages/core/db/schema.ts', 'packages/core/drizzle/'];
const DEFAULT_AUTH_SECRETS_PATHS = ['apps/web/src/app/api/secrets/', 'packages/core/secrets/'];
const DEFAULT_CI_DEPLOY_PATHS = ['.github/workflows/', 'docker/worker/Dockerfile', 'vercel.json'];

const SPENDING_TEXT_PATTERN = /\$\s?\d|\bbudget\b|\bsubscription\b|\bupgrad(?:e|ed|es|ing)\s+(?:the\s+|your\s+|this\s+)?plan\b|\bspend(?:ing)?\b|\bpurchase\b|\bcredit card\b|\bpricing tier\b/i;

export interface HardRailInput {
  pathManifest?: readonly string[] | null;
  /** Detected paths for the workspace's `destructive_schema_change` risk class; absent ⇒ the default fallback. */
  schemaPaths?: readonly string[];
  /** Detected paths for `auth_and_secrets`; absent ⇒ the default fallback. */
  authSecretsPaths?: readonly string[];
  /** Detected paths for `ci_deploy_config`; absent ⇒ the default fallback. */
  ciDeployPaths?: readonly string[];
  /** The workspace's own declared deny/escalate paths, beyond the three universal classes above. */
  protectedPaths?: readonly string[];
  /** The question's own visible text (prompt, context, option labels/consequences, recommended). */
  questionText?: string;
}

function pathsHit(manifest: readonly string[], prefixes: readonly string[]): boolean {
  return prefixes.length > 0 && manifest.some(p => prefixes.some(prefix => p.startsWith(prefix)));
}

/** The hard rail blocking `decide`/`hold` for this question, or null when none applies. */
export function detectHardRail(input: HardRailInput): HardRailKind | null {
  const manifest = input.pathManifest ?? [];
  if (manifest.length > 0) {
    if (pathsHit(manifest, input.schemaPaths ?? DEFAULT_SCHEMA_PATHS)) return 'migration';
    if (pathsHit(manifest, input.authSecretsPaths ?? DEFAULT_AUTH_SECRETS_PATHS)) return 'auth_secrets';
    if (pathsHit(manifest, input.ciDeployPaths ?? DEFAULT_CI_DEPLOY_PATHS)) return 'ci_deploy';
    if (pathsHit(manifest, input.protectedPaths ?? [])) return 'protected_path';
  }
  if (input.questionText && SPENDING_TEXT_PATTERN.test(input.questionText)) return 'spending';
  return null;
}

/**
 * How long a `hold` can go without a person seeing it. A held question parks
 * without a notification; the worker PATCH route clamps its `resurfaceAt` to
 * at most this far from the first park, and the resurface pass
 * (apps/web/src/lib/question-hold.ts, on /api/cron/notify-away's ticks)
 * notifies a person once it passes, if the question is still unanswered.
 */
export const HOLD_RESURFACE_MS = 15 * 60_000;

/** Jev gives no free-text reason today (see `QUESTION_DECIDE_QUESTIONS` in ./question-gate-decision.ts — disposition only, no reason-code question); this is what a held question's `holdReason` reads until that changes. */
export const DEFAULT_HOLD_REASON = "Held — it didn't look urgent enough to interrupt someone right now.";

export const QUESTION_DECIDE_PROMPT_VERSION = 'qd1';
export const QUESTION_DECIDE_DECISION_TIMEOUT_MS = 3_000;

export interface QuestionDecideAnswer {
  disposition: QuestionDisposition;
  dispositionConfidence: number;
  optionIndex: number | null;
  optionIndexConfidence: number | null;
}

export interface DecideResolution {
  disposition: QuestionDisposition;
  confidence: number;
  optionIndex?: number;
  optionConfidence?: number;
  /** Set only when the disposition was forced to `ask` despite Jev saying otherwise. */
  fellBackReason?: 'low_confidence' | 'invalid_option' | 'no_options';
}

/**
 * Turn an answered decide call into a final disposition. Pure: fails open to
 * `ask` on low confidence, a `decide` with no usable option index, or a
 * question with no options to pick from — `decide`/`hold` only ever apply
 * when Jev is both confident and gave something actionable.
 */
export function resolveDecideOutcome(
  answer: QuestionDecideAnswer,
  optionCount: number,
  minConfidence: number,
): DecideResolution {
  if (answer.dispositionConfidence < minConfidence) {
    return { disposition: 'ask', confidence: answer.dispositionConfidence, fellBackReason: 'low_confidence' };
  }
  if (answer.disposition !== 'decide') {
    return { disposition: answer.disposition, confidence: answer.dispositionConfidence };
  }
  if (optionCount === 0) {
    return { disposition: 'ask', confidence: answer.dispositionConfidence, fellBackReason: 'no_options' };
  }
  if (answer.optionIndex === null || answer.optionIndex >= optionCount) {
    return { disposition: 'ask', confidence: answer.dispositionConfidence, fellBackReason: 'invalid_option' };
  }
  return {
    disposition: 'decide',
    confidence: answer.dispositionConfidence,
    optionIndex: answer.optionIndex,
    ...(answer.optionIndexConfidence !== null ? { optionConfidence: answer.optionIndexConfidence } : {}),
  };
}

/** A stable hash of the inputs a decision call actually saw, for the decision ledger's `fingerprint` column. */
export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
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
 * What happened to one question, for the question-check reply:
 *  - `pushback`: a confident `needs_context`; not sent, the agent asks again.
 *  - `max_pushbacks`: this worker already had its pushbacks; sent as-is.
 *  - `sensitive`: the workspace never sends text out; sent, no model call.
 *  - `off`: the workspace's kill switch (`jevQuestionGate: false`) is set; sent, nothing else runs.
 *  - `error`: a decision call failed (no key, timeout, transport) at either stage; sent (fail open).
 *  - `hard_rail`: a hard rail applies; sent (`reply.rail` names which one).
 *  - `decided`: Jev picked an option; NOT sent — the agent gets the answer as the tool result.
 *  - `held`: Jev held the question; sent (parked), tagged `disposition: 'hold'`.
 *  - `asked`: Jev said ask, or decide/hold fell back to ask; sent (parked), unchanged from before.
 */
export type QuestionGateOutcome =
  | 'actionable' | 'pushback' | 'max_pushbacks' | 'sensitive' | 'off' | 'error'
  | 'hard_rail' | 'decided' | 'held' | 'asked';

export interface QuestionGateDecision {
  optionIndex: number;
  label: string;
  confidence: number;
}

export interface QuestionGateReply {
  verdict: 'send' | 'pushback' | 'decide';
  outcome: QuestionGateOutcome;
  /** Pushback text (verdict `pushback`) or the answer text for the AskUserQuestion tool result (verdict `decide`). */
  reason?: string;
  label?: QuestionGateLabel;
  confidence?: number;
  disposition?: QuestionDisposition;
  /** Set only when `outcome === 'hard_rail'`. */
  rail?: HardRailKind;
  decision?: QuestionGateDecision;
  holdReason?: string;
  /** ISO timestamp; see `HOLD_RESURFACE_MS`. */
  resurfaceAt?: string;
  error?: string;
  version: string | null;
  latencyMs: number;
}

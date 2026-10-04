/**
 * The shared access adapter for conflict-aware orchestration decisions
 * (knowledge-base: buildd/design/conflict-aware-orchestration.md §5 intro and §6).
 *
 * One entry point, `runOrchestrationDecision`, that every orchestration call
 * site (creation-time scope prediction, claim-time hold/start) goes through. It
 * owns the parts that must not differ between call sites:
 *
 *  - **Access** goes through `resolveDecisionAccess` (./decision-client.ts):
 *    the team's inference policy, credential scoping and decision-model
 *    routing. No new credential path. The policy check runs first, so a team
 *    that has not opted in costs one team-row read and no retrieval.
 *  - **One overall deadline** (default 5s) covers access, retrieval/state
 *    assembly AND the decision call. Retrieval receives an `AbortSignal` that
 *    fires when the deadline passes; anything still running is abandoned.
 *  - **Application needs three yeses**: the kit's policy (`gated`/`live` and
 *    the measured threshold) permits it, `isJevModel` passes on the model that
 *    actually answered (thresholds were measured on Jev; another team model is
 *    recorded, never applied, even in `live`), and the unit was drawn into the
 *    applying cohort. The cohort fraction defaults to ZERO, so a new policy
 *    applies nothing until someone raises it after a readout.
 *  - **Every failure falls back** to the deterministic rule verdict the caller
 *    passed in: no key, timeout, invalid answer, provider error, empty
 *    candidate set, a thrown dependency. Never throws.
 *  - **A content-free ledger row** per look (`orchestration_decisions`): ids,
 *    versions, fingerprint, candidate digest, opaque labels and numbers. A
 *    label that is not a short opaque token is stored hashed, so a call site
 *    that passes a file path by mistake cannot leak it into the ledger.
 *
 * `decisionCall` is used rather than `Decision.run` because `run` pins the
 * definition's model and endpoint, which would bypass the team's decision
 * model routing. The definition's questions are sent unchanged and its policy
 * (`policyOf`) is applied to the answer, so `decisionId`, `version` and
 * `fingerprint` still identify exactly what was asked and how it was gated;
 * the `model` column records who actually answered.
 *
 * No DB import at module scope: the default deps load the client lazily, so a
 * test (or a script with its own deps) runs with no database.
 */
import { createHash } from 'node:crypto';
import {
  applyDecisionPolicy,
  type Decision,
  type DecisionQuestions,
  type DecisionReceipt,
  type DecisionText,
  type DecideResult,
  type QuestionOutcome,
} from '@builddai/ai-kit/decide';
import { isJevModel } from './decision-model';
import type { DecisionAccess, DecisionResult, DecisionCallParams } from './decision-client';
import type { InferenceCapability } from './inference-policy';

/** Overall ceiling: access + retrieval + decision. */
export const ORCHESTRATION_DECISION_DEADLINE_MS = 5_000;

/** Below this much remaining budget a decision call is not started. */
export const MIN_DECISION_BUDGET_MS = 25;

export type OrchestrationCapability = Extract<InferenceCapability, 'orchestration_manifest' | 'orchestration_claim' | 'orchestration_ordering'>;

/** Why the rule verdict stood: the call did not produce a usable answer. */
export type OrchestrationFallbackReason =
  | 'capability_disabled'
  | 'missing_key'
  | 'retrieval_error'
  | 'no_candidates'
  | 'deadline'
  | 'invalid'
  | 'error';

/** Why a usable answer was recorded but not applied. */
export type OrchestrationSuggestReason = 'shadow' | 'below_threshold' | 'non_jev' | 'not_in_cohort';

export type OrchestrationDecisionStatus = 'applied' | 'suggested' | 'fallback';

export interface OrchestrationScope {
  teamId: string;
  workspaceId: string;
  missionId?: string | null;
  taskId?: string | null;
  workerId?: string | null;
  accountId?: string | null;
  userId?: string | null;
  /** The PR/head/base the decision was about, when there is one — the outcome join keys. */
  prNumber?: number | null;
  headSha?: string | null;
  baseRef?: string | null;
  baseSha?: string | null;
}

/** Identity of the candidate set the model chose from. Content-free. */
export interface CandidatePolicy {
  /** Version of the code that builds the candidate set (bump with it). */
  version: string;
  /** `candidateDigest` of the candidates actually offered. */
  digest: string;
  count: number;
  /** True when candidates were cut by a cap: the answer covers a partial set. */
  truncated?: boolean;
}

export interface ApplyingCohort {
  /** Share of units drawn into the applying arm. Default 0. */
  fraction?: number;
  /** Assignment unit (task id by default). */
  unitId?: string;
  /** Default: the decision id. Change it to redraw. */
  salt?: string;
}

/** One `orchestration_decisions` row, as written. */
export interface OrchestrationDecisionRow {
  teamId: string;
  workspaceId: string;
  missionId: string | null;
  taskId: string | null;
  workerId: string | null;
  prNumber: number | null;
  headSha: string | null;
  baseRef: string | null;
  baseSha: string | null;
  capability: string;
  decisionId: string;
  decisionVersion: string;
  fingerprint: string;
  question: string;
  step: number;
  mode: 'shadow' | 'gated' | 'live';
  minConfidence: number | null;
  model: string | null;
  candidatePolicyVersion: string;
  candidateDigest: string;
  candidateCount: number;
  candidateTruncated: boolean;
  ruleVerdict: string | null;
  suggested: string | null;
  confidence: number | null;
  effective: string | null;
  applied: boolean;
  status: OrchestrationDecisionStatus;
  reason: OrchestrationFallbackReason | OrchestrationSuggestReason | null;
  errorKind: string | null;
  latencyMs: number;
  retrievalMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  experimentArm: 'apply' | 'observe';
  propensity: number;
  applyingFraction: number;
  receipt: DecisionReceipt | null;
}

type CallFn = <Q extends DecisionQuestions>(params: DecisionCallParams<Q>) => Promise<DecisionResult<Q>>;
type ResolveAccessFn = (opts: {
  capability: InferenceCapability;
  teamId: string;
  workspaceId?: string | null;
  accountId?: string | null;
  userId?: string | null;
}) => Promise<DecisionAccess>;

export interface OrchestrationDecisionDeps {
  resolveAccess?: ResolveAccessFn;
  call?: CallFn;
  /** Persist the row. Awaited; a throw is swallowed. */
  record?: (row: OrchestrationDecisionRow) => Promise<void>;
  /** Forward the provider receipt (e.g. to `ai_usage`). Fire-and-forget. */
  onReceipt?: (receipt: DecisionReceipt) => void | Promise<void>;
  now?: () => number;
}

export interface OrchestrationDecisionParams<Q extends DecisionQuestions> {
  decision: Decision<Q>;
  /** The question whose answer the caller acts on. */
  question: keyof Q & string;
  capability: OrchestrationCapability;
  scope: OrchestrationScope;
  /** What today's deterministic rule decided. Returned whenever nothing applies. */
  ruleVerdict: string;
  candidatePolicy: CandidatePolicy;
  /**
   * Retrieval and state assembly, inside the shared deadline. Return null when
   * there is nothing to ask (no candidates): the rule stands, nothing is spent.
   * Must stop work when `signal` aborts.
   */
  buildState: (signal: AbortSignal) => Promise<DecisionText | null>;
  /** Reject an answer the caller cannot act on (outside the candidate map, say). */
  isValidAnswer?: (value: string | number | boolean) => boolean;
  cohort?: ApplyingCohort;
  deadlineMs?: number;
  /**
   * Absolute deadline (epoch ms, on `deps.now`'s clock). Wins over
   * `deadlineMs`: a repeated choice (§5a) passes one `deadlineAt` to every
   * step so all picks share the single overall budget.
   */
  deadlineAt?: number;
  /** Pick index in a repeated choice (§5a). Default 0. */
  step?: number;
  deps?: OrchestrationDecisionDeps;
}

export interface OrchestrationDecisionOutcome {
  /** What the caller acts on: the answer when applied, otherwise `ruleVerdict`. */
  effective: string;
  applied: boolean;
  status: OrchestrationDecisionStatus;
  reason: OrchestrationFallbackReason | OrchestrationSuggestReason | null;
  /** The model's answer as a string, when one came back. */
  suggested: string | null;
  confidence: number | null;
  /** The row handed to `record` (null when nothing is recorded: a team not opted in). */
  row: OrchestrationDecisionRow | null;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

const clampFraction = (f: unknown): number => {
  const n = typeof f === 'number' && Number.isFinite(f) ? f : 0;
  return Math.min(1, Math.max(0, n));
};

/**
 * Deterministic applying-cohort draw. The propensity is the probability of
 * the arm actually drawn, recorded at assignment (never reconstructed from a
 * fraction that may since have changed).
 */
export function assignApplyingArm(opts: { unitId: string; salt: string; fraction?: number }): { arm: 'apply' | 'observe'; propensity: number; fraction: number } {
  const fraction = clampFraction(opts.fraction);
  if (fraction <= 0) return { arm: 'observe', propensity: 1, fraction: 0 };
  if (fraction >= 1) return { arm: 'apply', propensity: 1, fraction: 1 };
  const h = createHash('sha256').update(`${opts.salt}:${opts.unitId}`).digest();
  const u = h.readUInt32BE(0) / 0x1_0000_0000;
  return u < fraction ? { arm: 'apply', propensity: fraction, fraction } : { arm: 'observe', propensity: 1 - fraction, fraction };
}

/** Order- and duplicate-insensitive digest of a candidate set. 16 hex chars. */
export function candidateDigest(candidates: readonly string[]): string {
  const sorted = [...new Set(candidates)].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
}

const OPAQUE_LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * A label as the ledger stores it: short opaque tokens (`START`, `c17`,
 * `true`) as-is; anything else (a path, free text) as `h:<digest>`. The ledger
 * is content-free by construction, not by call-site discipline.
 */
export function contentFreeLabel(value: string | number | boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (OPAQUE_LABEL.test(s) && !s.includes('/')) return s;
  return `h:${createHash('sha256').update(s).digest('hex').slice(0, 16)}`;
}

function fallbackReasonFor(kind: string): OrchestrationFallbackReason {
  if (kind === 'timeout') return 'deadline';
  if (kind === 'parse' || kind === 'invalid_request' || kind === 'uncalibrated') return 'invalid';
  if (kind === 'missing_key') return 'missing_key';
  if (kind === 'capability_disabled') return 'capability_disabled';
  return 'error';
}

const DEADLINE = Symbol('deadline');

/** Resolve `p`, or `DEADLINE` once `ms` passes. Never rejects on the timer. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  if (ms <= 0) {
    p.catch(() => {});
    return Promise.resolve(DEADLINE);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<typeof DEADLINE>(resolve => { timer = setTimeout(() => resolve(DEADLINE), ms); });
  return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer); });
}

// ── Default deps (lazy) ──────────────────────────────────────────────────────

const defaultResolveAccess: ResolveAccessFn = async (opts) => {
  const { resolveDecisionAccess } = await import('./decision-client');
  return resolveDecisionAccess(opts);
};

const defaultCall: CallFn = async (params) => {
  const { decisionCall } = await import('./decision-client');
  return decisionCall(params);
};

const defaultRecord = async (row: OrchestrationDecisionRow): Promise<void> => {
  const { recordOrchestrationDecision } = await import('./orchestration-ledger-source');
  await recordOrchestrationDecision(row);
};

// ── The adapter ──────────────────────────────────────────────────────────────

export async function runOrchestrationDecision<Q extends DecisionQuestions>(
  params: OrchestrationDecisionParams<Q>,
): Promise<OrchestrationDecisionOutcome> {
  const deps = params.deps ?? {};
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const deadlineMs = Math.max(0, typeof params.deadlineAt === 'number'
    ? params.deadlineAt - started
    : params.deadlineMs ?? ORCHESTRATION_DECISION_DEADLINE_MS);
  const remaining = () => deadlineMs - (now() - started);
  const { decision, question, scope, candidatePolicy } = params;

  const policy = (() => {
    try { return decision.policyOf(question); } catch { return null; }
  })();
  const cohort = assignApplyingArm({
    unitId: params.cohort?.unitId ?? scope.taskId ?? scope.workspaceId,
    salt: params.cohort?.salt ?? decision.id,
    fraction: params.cohort?.fraction,
  });

  let retrievalMs: number | null = null;
  const baseRow = (): OrchestrationDecisionRow => ({
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    missionId: scope.missionId ?? null,
    taskId: scope.taskId ?? null,
    workerId: scope.workerId ?? null,
    prNumber: scope.prNumber ?? null,
    headSha: scope.headSha ?? null,
    baseRef: scope.baseRef ?? null,
    baseSha: scope.baseSha ?? null,
    capability: params.capability,
    decisionId: decision.id,
    decisionVersion: decision.version,
    fingerprint: decision.fingerprint,
    question,
    step: params.step ?? 0,
    mode: policy?.mode ?? 'shadow',
    minConfidence: policy?.minConfidence ?? null,
    model: null,
    candidatePolicyVersion: candidatePolicy.version,
    candidateDigest: candidatePolicy.digest,
    candidateCount: candidatePolicy.count,
    candidateTruncated: candidatePolicy.truncated === true,
    ruleVerdict: contentFreeLabel(params.ruleVerdict),
    suggested: null,
    confidence: null,
    effective: contentFreeLabel(params.ruleVerdict),
    applied: false,
    status: 'fallback',
    reason: null,
    errorKind: null,
    latencyMs: 0,
    retrievalMs,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    experimentArm: cohort.arm,
    propensity: cohort.propensity,
    applyingFraction: cohort.fraction,
    receipt: null,
  });

  const record = async (row: OrchestrationDecisionRow) => {
    try {
      await (deps.record ?? defaultRecord)(row);
    } catch (err) {
      console.warn('[orchestration-decision] ledger write failed (non-fatal):', (err as Error)?.message ?? err);
    }
  };

  const finish = async (
    outcome: Omit<OrchestrationDecisionOutcome, 'row'>,
    patch: Partial<OrchestrationDecisionRow>,
    persist = true,
  ): Promise<OrchestrationDecisionOutcome> => {
    const row: OrchestrationDecisionRow = {
      ...baseRow(),
      retrievalMs,
      status: outcome.status,
      reason: outcome.reason,
      applied: outcome.applied,
      suggested: contentFreeLabel(outcome.suggested),
      confidence: outcome.confidence,
      effective: contentFreeLabel(outcome.effective),
      latencyMs: Math.max(0, now() - started),
      ...patch,
    };
    if (persist) await record(row);
    return { ...outcome, row: persist ? row : null };
  };

  const fallback = (reason: OrchestrationFallbackReason, patch: Partial<OrchestrationDecisionRow> = {}, extra: { suggested?: string | null; confidence?: number | null } = {}, persist = true) =>
    finish({ effective: params.ruleVerdict, applied: false, status: 'fallback', reason, suggested: extra.suggested ?? null, confidence: extra.confidence ?? null }, { errorKind: patch.errorKind ?? reason, ...patch }, persist);

  try {
    if (!policy || !(question in decision.questions)) {
      return await fallback('invalid', { errorKind: 'unknown_question' }, {}, false);
    }

    // 1. Access: policy first, then the team's key and model route.
    const access = await withDeadline((deps.resolveAccess ?? defaultResolveAccess)({
      capability: params.capability,
      teamId: scope.teamId,
      workspaceId: scope.workspaceId,
      accountId: scope.accountId ?? null,
      userId: scope.userId ?? null,
    }), remaining());
    if (access === DEADLINE) return await fallback('deadline');
    if (!access.ok) {
      // A team that has not opted in writes nothing: the ledger is for teams
      // that turned the policy on. An opted-in team without a key is recorded.
      if (access.error.kind === 'capability_disabled') return await fallback('capability_disabled', {}, {}, false);
      return await fallback('missing_key');
    }

    // 2. Retrieval / state, inside the same deadline, cancelled on expiry.
    const controller = new AbortController();
    const retrievalStart = now();
    let state: DecisionText | null | typeof DEADLINE;
    try {
      state = await withDeadline(Promise.resolve().then(() => params.buildState(controller.signal)), remaining());
    } catch (err) {
      retrievalMs = now() - retrievalStart;
      return await fallback('retrieval_error', { errorKind: 'retrieval_error', model: access.model });
    }
    retrievalMs = now() - retrievalStart;
    if (state === DEADLINE) {
      controller.abort();
      return await fallback('deadline', { model: access.model });
    }
    if (state === null || state === undefined) return await fallback('no_candidates', { model: access.model });

    // 3. The decision, with whatever budget is left.
    const budget = remaining();
    if (budget < MIN_DECISION_BUDGET_MS) return await fallback('deadline', { model: access.model });
    let receipt: DecisionReceipt | null = null;
    const result = await withDeadline((deps.call ?? defaultCall)({
      capability: params.capability,
      teamId: scope.teamId,
      workspaceId: scope.workspaceId,
      accountId: scope.accountId ?? null,
      userId: scope.userId ?? null,
      state,
      questions: decision.questions,
      timeoutMs: budget,
      access,
      decisionId: decision.id,
      onUsage: (r) => {
        receipt = r;
        if (deps.onReceipt) {
          try { void Promise.resolve(deps.onReceipt(r)).catch(() => {}); } catch { /* never affects the decision */ }
        }
      },
    }), budget);
    if (result === DEADLINE) return await fallback('deadline', { model: access.model, receipt });

    const usage = result.ok
      ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd: result.usage.costUsd }
      : {};
    const answeredModel = result.ok ? result.model : access.model;
    const synthesizedReceipt: DecisionReceipt = receipt ?? {
      kind: 'decision', decisionId: decision.id, provider: 'openrouter', model: answeredModel,
      usage: result.ok ? { ...result.usage } : { inputTokens: 0, outputTokens: 0, costUsd: null },
      latencyMs: result.latencyMs, outcome: result.ok ? 'ok' : 'error', attempts: result.attempts,
    };

    if (!result.ok) {
      return await fallback(fallbackReasonFor(result.error.kind), { errorKind: result.error.kind, model: answeredModel, receipt: synthesizedReceipt });
    }

    const outcomes = applyDecisionPolicy(decision.questions, result as DecideResult<Q>, decision.policyOf);
    const outcome = outcomes[question] as QuestionOutcome;
    if (outcome.status === 'skipped') {
      return await fallback(fallbackReasonFor(outcome.error.kind), { errorKind: outcome.error.kind, model: answeredModel, receipt: synthesizedReceipt, ...usage });
    }
    const value = outcome.value as string | number | boolean;
    const suggested = String(value);
    const rowPatch = { model: answeredModel, receipt: synthesizedReceipt, errorKind: null, ...usage };

    if (params.isValidAnswer && !params.isValidAnswer(value)) {
      return await fallback('invalid', { ...rowPatch, errorKind: 'invalid_answer' }, { suggested, confidence: outcome.confidence });
    }

    let reason: OrchestrationSuggestReason | null = null;
    if (outcome.status === 'suggested') reason = outcome.reason;
    else if (!isJevModel(answeredModel)) reason = 'non_jev';
    else if (cohort.arm !== 'apply') reason = 'not_in_cohort';

    if (reason) {
      return await finish(
        { effective: params.ruleVerdict, applied: false, status: 'suggested', reason, suggested, confidence: outcome.confidence },
        rowPatch,
      );
    }
    return await finish(
      { effective: suggested, applied: true, status: 'applied', reason: null, suggested, confidence: outcome.confidence },
      rowPatch,
    );
  } catch (err) {
    console.warn('[orchestration-decision] failed open to the rule:', (err as Error)?.message ?? err);
    return await fallback('error', { errorKind: 'exception' });
  }
}

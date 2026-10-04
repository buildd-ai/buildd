/**
 * Decision kinds: the stable contract a caller targets instead of a model.
 *
 * A caller asks a *kind* ("should this session get deep analysis?") with
 * bounded, typed features and gets back a typed decision. Which provider and
 * model answered, whether a richer model was consulted, and what happened when
 * none could answer are policy, owned here and by the kind, never by the
 * caller. A better model is a runtime change, not a caller migration.
 *
 * The plan, in order:
 *
 * 1. **Features.** The kind validates and narrows the caller's input
 *    (`parseFeatures`). Anything out of bounds is refused before any spend.
 * 2. **Deterministic override.** A rule the kind owns (`override`). When it
 *    fires, no model is asked, in every mode, disabled included: a hard
 *    trigger is code, not a rollout.
 * 3. **Cheap model** (`runtime.cheap`). Applied at or above the kind's
 *    `minConfidence`.
 * 4. **Escalation slot** (`runtime.escalation`), optional: a richer model or an
 *    ensemble (any invoker) asked when the cheap attempt was below threshold
 *    (or failed, if the kind opts in), the caller allows it and the latency and
 *    cost budgets have room. Applied at `escalation.minConfidence`.
 * 5. **Per-kind fallback.** The kind's own safe answer, told why it is needed.
 *    The platform normalizes provider failures; it never invents a fallback.
 *
 * Confidence semantics: `confidence` on a model decision is the kind's
 * `interpret` reading of the answer, in [0, 1], compared against the kind's
 * threshold for the route that answered. A rule or fallback decision has no
 * confidence (null), not 1: it was not estimated. A threshold is measured on
 * a model; a route that says its model was not measured (`isMeasured`) is
 * recorded but never applied.
 *
 * Versions are independent so a readout can split them: `policyVersion` (the
 * kind's rules, thresholds and fallback, bumped by its author),
 * `featureSchemaVersion` (what the features mean), `promptFingerprint` (the
 * questions asked), `configFingerprint` (decision set, thresholds, escalation
 * policy) and, per attempt, the provider and the model that answered.
 *
 * Every attempt is kept on the response (`attempts`), applied or not, so a
 * ledger can compare cheap-only, escalated and final answers. Whether a
 * decision turned out right is not this module's business: outcomes are
 * attached later, against the record, by the kind's outcome adapter.
 *
 * Imports from `./index` are used inside functions only (index re-exports
 * this module), so the cycle is safe.
 */

import {
  canonicalJson,
  decide,
  describeDecideError,
  isRetryableStatus,
  resolveDecisionEndpoint,
  shortHash,
  validateDecisionRequest,
  DECIDE_ENGINE_VERSION,
  DEFAULT_DECIDE_TIMEOUT_MS,
  DEFAULT_MIN_RETRY_BUDGET_MS,
  JEV_MODEL,
  type DecideError,
  type DecideParams,
  type DecideResult,
  type DecisionAnswers,
  type DecisionQuestions,
} from './index';

// ══ Types ═════════════════════════════════════════════════════════════════════

/** Where the decision in effect came from. */
export type DecisionSource = 'rule' | 'model' | 'fallback';

/** Which slot of the plan made an attempt. `challenger` is never applied. */
export type DecisionAttemptRole = 'cheap' | 'escalation' | 'challenger';

/** How a kind is rolled out for this call. */
export type DecisionRolloutMode = 'disabled' | 'shadow' | 'live';

/** Why the kind's fallback is the answer. */
export type DecisionFallbackCause =
  /** The kind is off for this caller. */
  | 'disabled'
  /** The features failed the kind's schema (or its rule threw). Nothing was asked. */
  | 'invalid_features'
  /** No route to ask: no key, no configured model. Nothing was asked. */
  | 'no_provider'
  /** Every attempt failed. */
  | 'provider_failure'
  /** Answers came back, none at the threshold. */
  | 'low_confidence'
  /** An answer cleared the threshold on a model the threshold was not measured on. */
  | 'unmeasured_model'
  /** Shadow: the model was asked and recorded; the fallback is what runs. */
  | 'shadow';

/** Every provider error, collapsed to what a policy or readout can act on. */
export type DecisionFailureKind =
  /** Nothing was asked: no key, capability off, SDK missing. */
  | 'unavailable'
  | 'timeout'
  | 'rate_limited'
  | 'provider_error'
  | 'transport'
  /** Refused locally before sending. */
  | 'invalid_request'
  /** Answered, but unusable: malformed, uncalibrated, or outside the kind's decision set. */
  | 'invalid_response';

export interface DecisionFailure {
  kind: DecisionFailureKind;
  /** Metadata only: never state, features or answers. */
  detail: string;
  /** Whether trying again (later, or on another route) could help. */
  retryable: boolean;
  /** HTTP status, for `provider_error`. */
  status?: number;
}

/** A decision a rule or fallback produced. */
export interface DecisionVerdict<D extends string> {
  decision: D;
  /** Stable, machine-readable: `hard_trigger`, `fallback_low_confidence`. Never prose from a model. */
  reasonCode: string;
}

/** A decision read from a model's answers. */
export interface ModelVerdict<D extends string> extends DecisionVerdict<D> {
  /** [0, 1]: the kind's reading of how sure the answer is. Compared to the kind's threshold. */
  confidence: number;
}

export interface DecisionEscalationPolicy {
  /** Threshold for the escalation route's answer. Default: the kind's `minConfidence`. */
  minConfidence?: number;
  /** What sends a cheap attempt up. Default `['low_confidence']`. */
  on?: readonly ('low_confidence' | 'provider_failure')[];
}

export type FeatureParse<F> = { ok: true; features: F } | { ok: false; message: string };

export interface DecisionKindConfig<K extends string, F, D extends string, Q extends DecisionQuestions> {
  /** Stable, namespaced id: `app.decision_name`. Never a model or provider name. */
  kind: K;
  /** Bump when rules, thresholds, escalation or fallback change. No spaces or `|`. */
  policyVersion: string;
  /** Bump when what the features mean changes. No spaces or `|`. */
  featureSchemaVersion: string;
  /** The closed output set. A caller can switch on it exhaustively. */
  decisions: readonly D[];
  /** Validate and bound untrusted input. Return trimmed features, or why not. Must not throw. */
  parseFeatures(input: unknown): FeatureParse<F>;
  /** A deterministic rule that decides without a model, or null to ask one. */
  override?(features: F): DecisionVerdict<D> | null;
  /** What a model is asked. Part of `promptFingerprint`. */
  questions: Q;
  /** The model's view of the features. Keep it small. */
  state(features: F): DecideParams<Q>['state'];
  /** Answers → decision. Null when the answers do not support one. */
  interpret(answers: DecisionAnswers<Q>, features: F): ModelVerdict<D> | null;
  /** Threshold for the cheap route, from a held-out eval of this kind. */
  minConfidence: number;
  /** Absent: this kind never escalates. */
  escalation?: DecisionEscalationPolicy;
  /**
   * The kind's safe answer when no model decision is applied. Must be total
   * and pure; `features` is null when they failed to parse. A fallback that
   * throws, or answers outside `decisions`, is a bug in the kind and throws.
   */
  fallback(features: F | null, cause: DecisionFallbackCause): DecisionVerdict<D>;
}

export interface DecisionKind<K extends string, F, D extends string, Q extends DecisionQuestions>
  extends Readonly<DecisionKindConfig<K, F, D, Q>> {
  /** Hash of the questions: what a model is asked. */
  readonly promptFingerprint: string;
  /** Hash of the decision set, thresholds and escalation policy. */
  readonly configFingerprint: string;
  /** `DECIDE_ENGINE_VERSION` when defined. */
  readonly engine: number;
}

// Any kind, for code that handles kinds generically.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDecisionKind = DecisionKind<string, any, string, any>;

export type DecisionKindDecision<T> = T extends DecisionKind<string, unknown, infer D, DecisionQuestions> ? D : never;

/** What a route is asked to answer. */
export interface DecisionInvocation<Q extends DecisionQuestions> {
  questions: Q;
  state: DecideParams<Q>['state'];
  /** This attempt's whole deadline. */
  timeoutMs: number;
  /** The kind id, for receipts. */
  decisionId: string;
}

/** A result from any invoker. Errors may carry kinds beyond `DecideError` (buildd's `capability_disabled`). */
export type DecisionInvokeResult<Q extends DecisionQuestions> =
  | Extract<DecideResult<Q>, { ok: true }>
  | { ok: false; error: DecideError | { kind: string }; latencyMs: number; attempts: number };

export type DecisionInvoker = <Q extends DecisionQuestions>(req: DecisionInvocation<Q>) => Promise<DecisionInvokeResult<Q>>;

/**
 * One way to get an answer: a provider + model behind an invoker. The invoker
 * is the existing transport (`decide`, buildd's `decisionCall`), or an
 * ensemble of them; this module never talks to a provider itself.
 */
export interface DecisionRoute {
  /** Who answers, for the record (`openrouter`, `openai`, a local name). Never read by callers. */
  provider: string;
  /** The requested model id. The versioned id that answered lands on the attempt. */
  model: string;
  invoke: DecisionInvoker;
  /** Per-attempt cap. Default the kit's 5s, and never past the request's latency budget. */
  timeoutMs?: number;
  /** Was the kind's threshold measured on the model that answered? Default yes. */
  isMeasured?: (answeringModel: string) => boolean;
}

/** The routes and rollout for one call, resolved by the platform (never by the caller). */
export interface DecisionRuntime {
  mode: DecisionRolloutMode;
  cheap?: DecisionRoute | null;
  /** The richer model / ensemble slot. */
  escalation?: DecisionRoute | null;
  /** Why there is no cheap route, when known: recorded on the response. */
  unavailable?: DecisionFailure | null;
}

export interface DecisionConstraints {
  /** Whole-plan latency budget. */
  maxLatencyMs?: number;
  /** No escalation once known spend reaches this. */
  maxCostUsd?: number;
  /** False forbids the escalation slot for this call. */
  allowEscalation?: boolean;
}

/** What the decision is about: ids only. */
export interface DecisionSubjectRef {
  type: string;
  id: string;
}

export interface DecisionRequest<F> {
  features: F;
  /** The schema the caller built `features` against. A mismatch is refused, not guessed at. */
  featureSchemaVersion?: string;
  subjectRef?: DecisionSubjectRef;
  constraints?: DecisionConstraints;
}

export interface DecisionAttempt<D extends string = string> {
  index: number;
  role: DecisionAttemptRole;
  provider: string;
  /** Requested. */
  model: string;
  /** The versioned id that answered; null when nothing answered. */
  modelVersion: string | null;
  outcome: 'decided' | 'below_threshold' | 'unmeasured' | 'failed';
  decision: D | null;
  confidence: number | null;
  reasonCode: string | null;
  threshold: number;
  failure: DecisionFailure | null;
  /** Did this attempt's decision take effect? */
  applied: boolean;
  /** The attempt this one escalated from. */
  escalatedFrom: number | null;
  latencyMs: number;
  /** Provider round trips inside this attempt (transport retries). */
  providerAttempts: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
}

export type EscalationSkip = 'not_configured' | 'no_route' | 'not_allowed' | 'latency_budget' | 'cost_budget';

export interface DecisionResponse<K extends string = string, D extends string = string> {
  kind: K;
  /** The decision in effect. Always one of the kind's `decisions`. */
  decision: D;
  /** Model decisions only. */
  confidence: number | null;
  reasonCode: string;
  source: DecisionSource;
  mode: DecisionRolloutMode;
  deterministicOverride: boolean;
  fallbackCause: DecisionFallbackCause | null;
  /** The route whose answer is in effect (source `model`), else null. */
  provider: string | null;
  model: string | null;
  modelVersion: string | null;
  policyVersion: string;
  featureSchemaVersion: string;
  promptFingerprint: string;
  configFingerprint: string;
  engine: number;
  /** Hash of the parsed features; null when they failed to parse. */
  featureDigest: string | null;
  subjectRef: DecisionSubjectRef | null;
  attempts: DecisionAttempt<D>[];
  /** Roles of the attempts, in order. */
  escalationChain: DecisionAttemptRole[];
  /** When the decision in effect came from an escalation: the attempt it escalated from. */
  escalatedFrom: number | null;
  /** Set when escalation was called for but did not run. */
  escalationSkipped: EscalationSkip | null;
  /** Why there was no cheap route, when known. */
  unavailable: DecisionFailure | null;
  latencyMs: number;
  /** Sum of known attempt costs; null when none reported a cost. */
  costUsd: number | null;
}

export interface RunDecisionKindOptions<K extends string, D extends string> {
  now?: () => number;
  /** Persist the response (ledger). Awaited; a throw is swallowed. */
  onRecord?: (response: DecisionResponse<K, D>) => void | Promise<void>;
}

// ══ Failures ══════════════════════════════════════════════════════════════════

/** Map any invoker error (the kit's, or a host's own kinds) to a `DecisionFailure`. */
export function normalizeDecisionFailure(error: DecideError | { kind: string; [k: string]: unknown }): DecisionFailure {
  const e = error as DecideError;
  switch (e.kind) {
    case 'missing_key':
    case 'sdk_missing':
      return { kind: 'unavailable', detail: describeDecideError(e), retryable: false };
    case 'timeout':
      return { kind: 'timeout', detail: describeDecideError(e), retryable: true };
    case 'rate_limited':
      return { kind: 'rate_limited', detail: describeDecideError(e), retryable: true };
    case 'provider_error':
      return { kind: 'provider_error', detail: describeDecideError(e), retryable: isRetryableStatus(e.status), status: e.status };
    case 'transport':
      return { kind: 'transport', detail: e.message, retryable: true };
    case 'invalid_request':
      return { kind: 'invalid_request', detail: e.message, retryable: false };
    case 'parse':
    case 'uncalibrated':
      return { kind: 'invalid_response', detail: describeDecideError(e), retryable: false };
  }
  const kind = (error as { kind: string }).kind;
  if (kind === 'capability_disabled') return { kind: 'unavailable', detail: 'capability disabled', retryable: false };
  return { kind: 'transport', detail: String(kind), retryable: false };
}

// ══ defineDecisionKind ════════════════════════════════════════════════════════

const KIND_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;
const VERSION_PART_RE = /^[^|\s]+$/;
const isUnit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** Throws at definition time (startup / test) on a malformed kind. */
export function defineDecisionKind<const K extends string, F, const D extends string, const Q extends DecisionQuestions>(
  config: DecisionKindConfig<K, F, D, Q>,
): DecisionKind<K, F, D, Q> {
  const id = config.kind;
  if (!KIND_RE.test(id)) throw new Error(`decision kind '${id}' must be namespaced, e.g. 'app.decision_name'`);
  if (!VERSION_PART_RE.test(config.policyVersion ?? '')) throw new Error(`decision kind '${id}': policyVersion must be non-empty with no spaces or '|'`);
  if (!VERSION_PART_RE.test(config.featureSchemaVersion ?? '')) throw new Error(`decision kind '${id}': featureSchemaVersion must be non-empty with no spaces or '|'`);
  if (!Array.isArray(config.decisions) || config.decisions.length === 0 || new Set(config.decisions).size !== config.decisions.length) {
    throw new Error(`decision kind '${id}': decisions must be a non-empty set with no duplicates`);
  }
  if (!isUnit(config.minConfidence)) throw new Error(`decision kind '${id}': minConfidence must be in [0, 1]`);
  if (config.escalation) {
    const m = config.escalation.minConfidence;
    if (m !== undefined && !isUnit(m)) throw new Error(`decision kind '${id}': escalation minConfidence must be in [0, 1]`);
    const on = config.escalation.on ?? ['low_confidence'];
    if (on.length === 0 || on.some(t => t !== 'low_confidence' && t !== 'provider_failure')) {
      throw new Error(`decision kind '${id}': escalation.on must list 'low_confidence' and/or 'provider_failure'`);
    }
  }
  const invalid = validateDecisionRequest('fingerprint', config.questions);
  if (invalid) throw new Error(`decision kind '${id}': ${invalid}`);
  for (const fn of ['parseFeatures', 'state', 'interpret', 'fallback'] as const) {
    if (typeof config[fn] !== 'function') throw new Error(`decision kind '${id}': ${fn} must be a function`);
  }

  return Object.freeze({
    ...config,
    decisions: Object.freeze([...config.decisions]),
    promptFingerprint: shortHash(canonicalJson(config.questions)),
    configFingerprint: shortHash(canonicalJson({
      decisions: [...config.decisions],
      minConfidence: config.minConfidence,
      escalation: config.escalation
        ? { minConfidence: config.escalation.minConfidence ?? config.minConfidence, on: [...(config.escalation.on ?? ['low_confidence'])].sort() }
        : null,
    })),
    engine: DECIDE_ENGINE_VERSION,
  });
}

// ══ Routes over the kit transport ═════════════════════════════════════════════

/**
 * A route over the kit's `decide` (Jev on OpenRouter by default, or any
 * `endpoint`). Hosts with their own gating wrap their own transport instead
 * (buildd: `decisionCall`); this is for a caller holding a key.
 */
export function decideRoute(
  params: Omit<DecideParams<DecisionQuestions>, 'questions' | 'state' | 'timeoutMs' | 'decisionId'> & {
    provider?: string;
    isMeasured?: (answeringModel: string) => boolean;
  },
): DecisionRoute {
  const { provider, isMeasured, ...rest } = params;
  const ep = resolveDecisionEndpoint(rest.endpoint);
  const model = rest.model ?? (ep.ok && ep.kind === 'chat' ? '' : JEV_MODEL);
  return {
    provider: provider ?? (ep.ok ? ep.provider : 'unknown'),
    model,
    ...(isMeasured ? { isMeasured } : {}),
    invoke: async req => decide({ ...rest, questions: req.questions, state: req.state, timeoutMs: req.timeoutMs, decisionId: req.decisionId }),
  };
}

// ══ One attempt ═══════════════════════════════════════════════════════════════

export interface AttemptOptions {
  role: DecisionAttemptRole;
  index?: number;
  /** Default: the kind's threshold for the role (escalation's for `escalation`). */
  threshold?: number;
  timeoutMs?: number;
  escalatedFrom?: number | null;
  now?: () => number;
}

function thresholdFor(kind: AnyDecisionKind, role: DecisionAttemptRole): number {
  return role === 'escalation' ? kind.escalation?.minConfidence ?? kind.minConfidence : kind.minConfidence;
}

/**
 * Ask one route. Never throws, never applies: the caller (the plan, or a
 * challenger runner) decides what is applied. Exported as the seam for
 * challenger execution.
 */
export async function runDecisionAttempt<K extends string, F, D extends string, Q extends DecisionQuestions>(
  kind: DecisionKind<K, F, D, Q>,
  route: DecisionRoute,
  features: F,
  opts: AttemptOptions,
): Promise<DecisionAttempt<D>> {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const threshold = opts.threshold ?? thresholdFor(kind, opts.role);
  const base: DecisionAttempt<D> = {
    index: opts.index ?? 0,
    role: opts.role,
    provider: route.provider,
    model: route.model,
    modelVersion: null,
    outcome: 'failed',
    decision: null,
    confidence: null,
    reasonCode: null,
    threshold,
    failure: null,
    applied: false,
    escalatedFrom: opts.escalatedFrom ?? null,
    latencyMs: 0,
    providerAttempts: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
  };
  const failed = (failure: DecisionFailure, extra: Partial<DecisionAttempt<D>> = {}): DecisionAttempt<D> =>
    ({ ...base, ...extra, outcome: 'failed', failure, latencyMs: Math.max(0, now() - started) });

  let state: DecideParams<Q>['state'];
  try {
    state = kind.state(features);
  } catch (e) {
    return failed({ kind: 'invalid_request', detail: `state: ${e instanceof Error ? e.message : String(e)}`, retryable: false });
  }

  let result: DecisionInvokeResult<Q>;
  try {
    result = await route.invoke<Q>({
      questions: kind.questions,
      state,
      timeoutMs: Math.max(1, Math.floor(opts.timeoutMs ?? route.timeoutMs ?? DEFAULT_DECIDE_TIMEOUT_MS)),
      decisionId: kind.kind,
    });
  } catch (e) {
    return failed({ kind: 'transport', detail: e instanceof Error ? e.message : String(e), retryable: true });
  }

  const latencyMs = Math.max(0, now() - started);
  if (!result.ok) {
    return { ...failed(normalizeDecisionFailure(result.error)), latencyMs, providerAttempts: result.attempts };
  }
  const answered = {
    modelVersion: result.model,
    latencyMs,
    providerAttempts: result.attempts,
    usage: { ...result.usage },
  };

  let verdict: ModelVerdict<D> | null;
  try {
    verdict = kind.interpret(result.answers, features);
  } catch (e) {
    return { ...failed({ kind: 'invalid_response', detail: `interpret: ${e instanceof Error ? e.message : String(e)}`, retryable: false }), ...answered };
  }
  if (!verdict || !kind.decisions.includes(verdict.decision) || !isUnit(verdict.confidence)) {
    return { ...failed({ kind: 'invalid_response', detail: 'answers did not yield a decision in the kind\'s set', retryable: false }), ...answered };
  }

  const measured = route.isMeasured ? route.isMeasured(result.model) : true;
  const outcome: DecisionAttempt['outcome'] = verdict.confidence < threshold ? 'below_threshold' : measured ? 'decided' : 'unmeasured';
  return {
    ...base,
    ...answered,
    outcome,
    decision: verdict.decision,
    confidence: verdict.confidence,
    reasonCode: verdict.reasonCode,
  };
}

// ══ The plan ══════════════════════════════════════════════════════════════════

function sumCost(attempts: readonly DecisionAttempt[]): number | null {
  const known = attempts.map(a => a.usage.costUsd).filter((c): c is number => typeof c === 'number');
  return known.length ? Math.round(known.reduce((s, c) => s + c, 0) * 1e12) / 1e12 : null;
}

/**
 * Run a kind's plan: rule → cheap → escalation → fallback. Never throws,
 * except on a kind bug (a fallback that throws or answers outside the set).
 */
export async function runDecisionKind<K extends string, F, D extends string, Q extends DecisionQuestions>(
  kind: DecisionKind<K, F, D, Q>,
  request: DecisionRequest<F>,
  runtime: DecisionRuntime,
  opts: RunDecisionKindOptions<K, D> = {},
): Promise<DecisionResponse<K, D>> {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const constraints = request.constraints ?? {};
  const deadline = constraints.maxLatencyMs === undefined ? Infinity : started + Math.max(0, constraints.maxLatencyMs);
  const attempts: DecisionAttempt<D>[] = [];
  let features: F | null = null;
  let featureDigest: string | null = null;
  let escalationSkipped: EscalationSkip | null = null;

  const respond = async (
    verdict: DecisionVerdict<D>,
    source: DecisionSource,
    extra: Partial<DecisionResponse<K, D>> = {},
  ): Promise<DecisionResponse<K, D>> => {
    const response: DecisionResponse<K, D> = {
      kind: kind.kind,
      decision: verdict.decision,
      confidence: null,
      reasonCode: verdict.reasonCode,
      source,
      mode: runtime.mode,
      deterministicOverride: false,
      fallbackCause: null,
      provider: null,
      model: null,
      modelVersion: null,
      policyVersion: kind.policyVersion,
      featureSchemaVersion: kind.featureSchemaVersion,
      promptFingerprint: kind.promptFingerprint,
      configFingerprint: kind.configFingerprint,
      engine: kind.engine,
      featureDigest,
      subjectRef: request.subjectRef ? { ...request.subjectRef } : null,
      attempts,
      escalationChain: attempts.map(a => a.role),
      escalatedFrom: null,
      escalationSkipped,
      unavailable: runtime.unavailable ?? null,
      latencyMs: Math.max(0, now() - started),
      costUsd: sumCost(attempts),
      ...extra,
    };
    if (opts.onRecord) {
      try {
        await opts.onRecord(response);
      } catch {
        // Recording never fails the decision.
      }
    }
    return response;
  };

  const fallback = (cause: DecisionFallbackCause): Promise<DecisionResponse<K, D>> => {
    let verdict: DecisionVerdict<D>;
    try {
      verdict = kind.fallback(features, cause);
    } catch (e) {
      throw new Error(`decision kind '${kind.kind}': fallback threw for '${cause}': ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!verdict || !kind.decisions.includes(verdict.decision)) {
      throw new Error(`decision kind '${kind.kind}': fallback for '${cause}' answered outside its decisions`);
    }
    return respond(verdict, 'fallback', { fallbackCause: cause });
  };

  // 1. Features, and 2. the deterministic override.
  let override: DecisionVerdict<D> | null = null;
  try {
    if (request.featureSchemaVersion !== undefined && request.featureSchemaVersion !== kind.featureSchemaVersion) {
      return fallback('invalid_features');
    }
    const parsed = kind.parseFeatures(request.features);
    if (!parsed.ok) return fallback('invalid_features');
    features = parsed.features;
    featureDigest = shortHash(canonicalJson(features));
    override = kind.override ? kind.override(features) : null;
  } catch {
    features = null;
    featureDigest = null;
    return fallback('invalid_features');
  }
  if (override) {
    if (!kind.decisions.includes(override.decision)) {
      throw new Error(`decision kind '${kind.kind}': override answered outside its decisions`);
    }
    return respond(override, 'rule', { deterministicOverride: true });
  }
  const f = features as F;

  if (runtime.mode === 'disabled') return fallback('disabled');
  if (!runtime.cheap) return fallback('no_provider');

  const remaining = () => deadline - now();
  const attemptTimeout = (route: DecisionRoute) =>
    Math.min(route.timeoutMs ?? DEFAULT_DECIDE_TIMEOUT_MS, remaining());

  // 3. The cheap model.
  const cheap = await runDecisionAttempt(kind, runtime.cheap, f, { role: 'cheap', index: 0, timeoutMs: attemptTimeout(runtime.cheap), now });
  attempts.push(cheap);
  let decisive: DecisionAttempt<D> | null = cheap.outcome === 'decided' ? cheap : null;

  // 4. The escalation slot.
  if (!decisive) {
    const triggers = kind.escalation?.on ?? ['low_confidence'];
    const trigger = cheap.outcome === 'failed' ? 'provider_failure' : 'low_confidence';
    if (!kind.escalation) {
      escalationSkipped = 'not_configured';
    } else if (triggers.includes(trigger)) {
      const spent = sumCost(attempts);
      if (!runtime.escalation) escalationSkipped = 'no_route';
      else if (constraints.allowEscalation === false) escalationSkipped = 'not_allowed';
      else if (remaining() < DEFAULT_MIN_RETRY_BUDGET_MS) escalationSkipped = 'latency_budget';
      else if (constraints.maxCostUsd !== undefined && spent !== null && spent >= constraints.maxCostUsd) escalationSkipped = 'cost_budget';
      else {
        const up = await runDecisionAttempt(kind, runtime.escalation, f, {
          role: 'escalation', index: attempts.length, timeoutMs: attemptTimeout(runtime.escalation), escalatedFrom: cheap.index, now,
        });
        attempts.push(up);
        if (up.outcome === 'decided') decisive = up;
      }
    }
  }

  // 5. Apply, shadow, or fall back.
  if (decisive && runtime.mode === 'live') {
    decisive.applied = true;
    return respond({ decision: decisive.decision!, reasonCode: decisive.reasonCode! }, 'model', {
      confidence: decisive.confidence,
      provider: decisive.provider,
      model: decisive.model,
      modelVersion: decisive.modelVersion,
      escalatedFrom: decisive.escalatedFrom,
    });
  }
  if (runtime.mode === 'shadow') return fallback('shadow');
  if (attempts.some(a => a.outcome === 'unmeasured')) return fallback('unmeasured_model');
  if (attempts.some(a => a.outcome === 'below_threshold')) return fallback('low_confidence');
  return fallback('provider_failure');
}

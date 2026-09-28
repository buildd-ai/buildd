/**
 * `@builddai/ai-kit/decide`: Jev decisions (server; peer `@typesafe-ai/sdk`).
 *
 * - Typed question builders: `choice`, `score`, `noul`.
 * - `decide({ apiKey, state, questions })`: one call over the TypeSafe SDK to
 *   OpenRouter's System One API. Never throws; bounded by one deadline with
 *   retries on 408/429/5xx; the model is pinned (`JEV_MODEL`), outside the
 *   tier system.
 * - `runDecisionPool`: fan-out with ~8 workers and a run budget (Jev takes
 *   one state per request).
 * - `defineDecision`: modes (`shadow | gated | live`), per-question
 *   thresholds, a `version` to stamp on rows, and a `fingerprint` that
 *   `expectDecisionPinned` checks so a changed definition fails a test until
 *   its version is bumped.
 * - `runDecisionEval`: accuracy and coverage at thresholds over labelled rows.
 * - Receipts (`DecisionReceipt`) are metadata only; `toModelsUsage` feeds `/models`' `recordUsage`.
 *
 * The caller passes its OpenRouter key; the kit never reads env vars.
 *
 * Splitting this file is fine: relative imports in the kit are extensionless
 * (`./x`) and `scripts/build.ts` rewrites them to `.js` for the published ESM.
 * Do not write `./x.js` here; Next (Turbopack) consuming the source cannot
 * resolve it (`scripts/build.test.ts` enforces this).
 */

// Type-only: erased from the emitted JS. The SDK is an optional peer, so the
// runtime import is lazy (`loadSdk`, in the transport section): this module
// loads without it, and only `decide` fails, with `sdk_missing`.
import type { TypeSafeClient, Fetch } from '@typesafe-ai/sdk';

// ══ Types ═════════════════════════════════════════════════════════════════════

/**
 * Question, answer and error types for `/decide`. Moved here from buildd's
 * `packages/core/decision-client.ts`, which now re-exports them.
 */

/** `instructions` and criteria descriptions may be a string, object or array. */
export type DecisionText = string | Record<string, unknown> | unknown[];

export interface ChoiceQuestion<L extends string = string> {
  type: 'choice';
  instructions: DecisionText;
  /** Label → definition (null when the label needs none). 2–255 labels. */
  criteria: Record<L, DecisionText | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: DecisionText;
  /** Ordered level descriptions, lowest first. 2–10 levels. */
  criteria: DecisionText[];
}

export interface NoulQuestion {
  type: 'noul';
  instructions: DecisionText;
  criteria?: { true?: DecisionText; false?: DecisionText };
}

export type DecisionQuestion = ChoiceQuestion<string> | ScoreQuestion | NoulQuestion;
export type DecisionQuestions = Record<string, DecisionQuestion>;

export interface ChoiceAnswer<L extends string = string> {
  type: 'choice';
  choice: L;
  probabilities: Record<L, number>;
  /** 0–1, derived by the provider from `probabilities`. */
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted level index; can land between levels. */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: 'noul';
  /** Probability the answer is yes. Carries no `confidence`. */
  noul: number;
}

export type AnswerFor<Q> =
  Q extends ChoiceQuestion<infer L> ? ChoiceAnswer<L>
  : Q extends ScoreQuestion ? ScoreAnswer
  : Q extends NoulQuestion ? NoulAnswer
  : never;

export type DecisionAnswers<Q extends DecisionQuestions> = { [K in keyof Q]: AnswerFor<Q[K]> };

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD, as reported by OpenRouter's `usage.cost`. Null when absent. */
  costUsd: number | null;
}

/** Every way `decide` can fail. It never throws. */
export type DecideError =
  | { kind: 'missing_key' }
  | { kind: 'invalid_request'; message: string }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'transport'; message: string }
  | { kind: 'rate_limited'; retryAfter?: number }
  | { kind: 'provider_error'; status: number; body: string }
  | { kind: 'parse'; message: string }
  /** The optional peer `@typesafe-ai/sdk` is not installed (or failed to load). No request was made. */
  | { kind: 'sdk_missing'; message: string };

export type DecideResult<Q extends DecisionQuestions> =
  | {
      ok: true;
      answers: DecisionAnswers<Q>;
      /** The versioned model that answered (log it next to any threshold). */
      model: string;
      usage: DecisionUsage;
      latencyMs: number;
      attempts: number;
    }
  | { ok: false; error: DecideError; latencyMs: number; attempts: number };

export function describeDecideError(error: DecideError): string {
  switch (error.kind) {
    case 'missing_key':
      return 'no OpenRouter decision key configured';
    case 'invalid_request':
      return `decision request rejected locally: ${error.message}`;
    case 'timeout':
      return `decision call exceeded ${error.timeoutMs}ms`;
    case 'transport':
      return `decision call failed to reach the provider: ${error.message}`;
    case 'rate_limited':
      return 'provider rate-limited the decision call';
    case 'provider_error':
      return `provider returned HTTP ${error.status}`;
    case 'parse':
      return `decision response did not match the questions: ${error.message}`;
    case 'sdk_missing':
      return `decide needs the optional peer dependency ${DECIDE_SDK_PACKAGE}; install it (npm install ${DECIDE_SDK_PACKAGE}): ${error.message}`;
  }
}

// ══ Questions: builders and pure checks ═══════════════════════════════════════

/**
 * Question builders plus the pure request/response checks. No I/O.
 */

/**
 * Jev's hard limit is 32K tokens for `state` plus the longest question. The
 * local check is a conservative *estimate* (≈3 chars/token), so a request that
 * would be refused upstream is refused here, for free.
 */
export const MAX_DECISION_TOKENS = 32_000;
const CHARS_PER_TOKEN_ESTIMATE = 3;

export const MIN_CHOICE_OPTIONS = 2;
export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

// ── Builders ──────────────────────────────────────────────────────────────────

/**
 * A closed-label question. `criteria` maps each label to its definition.
 *
 * Write every definition contrastively (what it covers, what it is not for),
 * and do not add a catch-all label ("other", "general"): it absorbs unfamiliar
 * input and inflates apparent accuracy. "Nothing fits" should show up as low
 * confidence, which the gate handles.
 */
export function choice<const L extends string>(
  instructions: DecisionText,
  criteria: Record<L, DecisionText | null>,
): ChoiceQuestion<L> {
  return { type: 'choice', instructions, criteria };
}

/** An ordered rubric of 2–10 levels, lowest first. The answer's `score` is a level index. */
export function score(instructions: DecisionText, levels: readonly DecisionText[]): ScoreQuestion {
  return { type: 'score', instructions, criteria: [...levels] };
}

/** A yes/no question. The answer is the probability of yes, with no `confidence`. */
export function noul(
  instructions: DecisionText,
  criteria?: { true?: DecisionText; false?: DecisionText },
): NoulQuestion {
  return criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };
}

// ── Local request validation ─────────────────────────────────────────────────

function textLength(v: unknown): number {
  return typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length;
}

export function estimateDecisionTokens(state: unknown, questions: DecisionQuestions): number {
  const longestQuestion = Math.max(0, ...Object.values(questions).map(q => textLength(q)));
  return Math.ceil((textLength(state) + longestQuestion) / CHARS_PER_TOKEN_ESTIMATE);
}

/** Returns an error message, or null when the request is well-formed. */
export function validateDecisionRequest(state: unknown, questions: DecisionQuestions): string | null {
  const names = Object.keys(questions);
  if (names.length === 0) return 'at least one question is required';
  if (state === undefined || state === null || (typeof state === 'string' && state.trim() === '')) {
    return 'state is empty';
  }
  for (const name of names) {
    const q = questions[name];
    if (!q || textLength(q.instructions) === 0 || q.instructions === '') {
      return `question '${name}' has no instructions`;
    }
    if (q.type === 'choice') {
      const n = Object.keys(q.criteria ?? {}).length;
      if (n < MIN_CHOICE_OPTIONS) return `choice '${name}' needs at least ${MIN_CHOICE_OPTIONS} labels`;
      if (n > MAX_CHOICE_OPTIONS) return `choice '${name}' has ${n} labels (max ${MAX_CHOICE_OPTIONS})`;
    } else if (q.type === 'score') {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
      if (n < MIN_SCORE_LEVELS || n > MAX_SCORE_LEVELS) {
        return `score '${name}' needs ${MIN_SCORE_LEVELS}-${MAX_SCORE_LEVELS} levels (got ${n})`;
      }
    } else if (q.type !== 'noul') {
      return `question '${name}' has unknown type`;
    }
  }
  const est = estimateDecisionTokens(state, questions);
  if (est > MAX_DECISION_TOKENS) return `estimated ${est} tokens exceeds the ${MAX_DECISION_TOKENS} limit`;
  return null;
}

// ── Response validation ──────────────────────────────────────────────────────

function isProbabilityMap(v: unknown): v is Record<string, number> {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every(n => typeof n === 'number' && Number.isFinite(n));
}

function isUnit(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * Check every answer against the question it claims to answer. A choice outside
 * the caller's label set is a parse failure, not a new label: the point of a
 * closed set is that code can switch on it exhaustively.
 */
export function parseDecisionAnswers<Q extends DecisionQuestions>(
  questions: Q,
  raw: unknown,
): { ok: true; answers: DecisionAnswers<Q> } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, message: 'answers missing' };
  const answers = raw as Record<string, any>;
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name];
    if (!a || typeof a !== 'object') return { ok: false, message: `no answer for '${name}'` };
    if (a.type !== q.type) return { ok: false, message: `answer '${name}' is ${a.type}, expected ${q.type}` };
    if (q.type === 'choice') {
      if (typeof a.choice !== 'string' || !(a.choice in q.criteria)) {
        return { ok: false, message: `choice '${name}' returned a label outside the set` };
      }
      if (!isProbabilityMap(a.probabilities) || !isUnit(a.confidence)) {
        return { ok: false, message: `choice '${name}' is missing probabilities or confidence` };
      }
    } else if (q.type === 'score') {
      if (typeof a.score !== 'number' || !Number.isFinite(a.score) || !isProbabilityMap(a.probabilities) || !isUnit(a.confidence)) {
        return { ok: false, message: `score '${name}' is malformed` };
      }
    } else if (!isUnit(a.noul)) {
      return { ok: false, message: `noul '${name}' is malformed` };
    }
  }
  const picked: Record<string, unknown> = {};
  for (const name of Object.keys(questions)) picked[name] = answers[name];
  return { ok: true, answers: picked as DecisionAnswers<Q> };
}

// ── Single-answer gate ───────────────────────────────────────────────────────

export type GateOutcome<L extends string> =
  | { apply: true; label: L; confidence: number }
  | { apply: false; reason: 'low_confidence' | 'no_answer'; label?: L; confidence?: number };

/**
 * Should a caller act on this choice? Only at or above `minConfidence`.
 *
 * Thresholds scale with the cost of a wrong answer and must come from a held-out
 * eval of the caller's own labelled data, not a round number. A threshold tuned
 * for one question does not transfer to another, and never from a Choice to a
 * Noul (which has no `confidence` at all).
 */
export function gateChoice<L extends string>(
  answer: ChoiceAnswer<L> | null | undefined,
  minConfidence: number,
): GateOutcome<L> {
  if (!answer) return { apply: false, reason: 'no_answer' };
  if (answer.confidence >= minConfidence) {
    return { apply: true, label: answer.choice, confidence: answer.confidence };
  }
  return { apply: false, reason: 'low_confidence', label: answer.choice, confidence: answer.confidence };
}

// ══ Usage receipts ════════════════════════════════════════════════════════════

/**
 * Usage receipts for decision calls: metadata only, never state, questions or
 * answers. `toModelsUsage` turns one into the input of `/models`'
 * `recordUsage`, so decision spend lands in the same buildd receipts and app
 * ledger as generative calls. `/decide` does not import `/models`: the shape
 * is structural, and a test asserts it stays assignable.
 */

export interface DecisionReceipt {
  kind: 'decision';
  /** `defineDecision` id, or null for a bare `decide` call. */
  decisionId: string | null;
  provider: 'openrouter';
  /** The versioned model that answered, or the requested model on failure. */
  model: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  latencyMs: number;
  outcome: 'ok' | 'error';
  attempts: number;
}

export type UsageSink = (receipt: DecisionReceipt) => void | Promise<void>;

export function toDecisionReceipt<Q extends DecisionQuestions>(
  result: DecideResult<Q>,
  opts: { model: string; decisionId?: string | null },
): DecisionReceipt {
  return {
    kind: 'decision',
    decisionId: opts.decisionId ?? null,
    provider: 'openrouter',
    model: result.ok ? result.model : opts.model,
    usage: result.ok ? { ...result.usage } : { inputTokens: 0, outputTokens: 0, costUsd: null },
    latencyMs: result.latencyMs,
    outcome: result.ok ? 'ok' : 'error',
    attempts: result.attempts,
  };
}

/** Fire-and-forget: a sink that throws or rejects never affects the decision. */
/** The `/models` tiers, restated so `/decide` needs no import from `/models`. */
export type ModelsTier = 'premium-plus' | 'premium' | 'standard' | 'budget';

/** Structurally `/models`' `UsageReceipt` (the input of `recordUsage`). */
export interface ModelsUsageInput {
  plan: {
    planId: string | null;
    planSource: 'registry' | 'pool' | 'catalog' | 'default' | 'cached' | 'fallback';
    model: string;
    provider: 'openrouter';
    /** Only when the app asked for one; Jev has no tier. */
    tier?: ModelsTier;
  };
  kind: 'decision';
  tokens: { input: number; output: number };
  costUsd: number | null;
  latencyMs: number;
  outcome: 'ok' | 'error';
}

/**
 * A decision receipt as `/models`' `recordUsage` input:
 * `models.recordUsage(toModelsUsage(receipt))`.
 *
 * Sent as `kind: 'decision'`, so buildd reports decision spend on its own
 * rather than as budget-tier chat. Jev is not a tier and has no buildd plan,
 * so the receipt says `planId: null` and `planSource: 'fallback'` (buildd
 * issued no plan) and carries no tier unless `opts.tier` names one.
 */
export function toModelsUsage(
  receipt: DecisionReceipt,
  opts: { tier?: ModelsTier; planId?: string | null } = {},
): ModelsUsageInput {
  return {
    plan: {
      planId: opts.planId ?? null,
      planSource: opts.planId ? 'default' : 'fallback',
      model: receipt.model,
      provider: 'openrouter',
      ...(opts.tier ? { tier: opts.tier } : {}),
    },
    kind: 'decision',
    tokens: { input: receipt.usage.inputTokens, output: receipt.usage.outputTokens },
    costUsd: receipt.usage.costUsd,
    latencyMs: Math.max(0, Math.round(receipt.latencyMs)),
    outcome: receipt.outcome,
  };
}

export function emitReceipt(sink: UsageSink | undefined, receipt: DecisionReceipt): void {
  if (!sink) return;
  try {
    const p = sink(receipt);
    if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
  } catch {
    // ignored by contract
  }
}

// ══ Transport ═════════════════════════════════════════════════════════════════

/**
 * `decide`: one Jev call over `@typesafe-ai/sdk`, pointed at OpenRouter's
 * System One API.
 *
 * - **Never throws.** Every failure is a `DecideError`, so the caller can fall
 *   back to the logic it had before the call existed.
 * - **Bounded.** One deadline (`timeoutMs`, default 5s) covers every attempt.
 *   Transient failures (408, 429, 5xx, network) are retried, by default once,
 *   and only while the deadline has at least `minRetryBudgetMs` left. The
 *   SDK's own retry is off: its budget is per attempt with no total ceiling,
 *   and two retry loops would stack.
 * - **Explicit.** Every SDK option is passed, because the SDK otherwise reads
 *   `TYPESAFE_*` env vars and a stray `TYPESAFE_BASE_URL` would send the key to
 *   another host. The kit never reads environment variables: the caller passes
 *   its OpenRouter key.
 * - **One state per request.** Fan-out goes through `runDecisionPool`.
 */

/** OpenRouter's System One API root, per OpenRouter's TypeSafe SDK guide. */
export const DECIDE_BASE_URL = 'https://openrouter.ai/api';

/** Where the SDK sends a decision (`baseURL` + `/v1/systemone`). */
export const DECIDE_URL = `${DECIDE_BASE_URL}/v1/systemone`;

/**
 * The one Jev model id, pinned. Not `~typesafe/jev-latest`: thresholds and
 * fingerprints are tuned against one version, and an alias can move under
 * them. Deliberately NOT a tier (`docs/design/decision-calls.md` Point 5): a
 * decision's version must name its model, and a registry remap would silently
 * invalidate every eval. A bump is a kit release; each app re-runs its eval
 * before taking it.
 */
export const JEV_MODEL = 'typesafe/jev-1.13';

/** Whole-call ceiling across all attempts. */
export const DEFAULT_DECIDE_TIMEOUT_MS = 5_000;
/** One retry by default. */
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_RETRY_BACKOFF_MS = 250;
/** Don't start a retry with less than this much deadline left. */
export const DEFAULT_MIN_RETRY_BUDGET_MS = 500;

/** 408, 429 and 5xx (incl. 524/529) are worth another attempt; other 4xx are the caller's bug or out-of-credit. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** The SDK's fetch shape; the global `fetch` fits it. */
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface DecideParams<Q extends DecisionQuestions> {
  /** The caller's OpenRouter key. Empty or missing ⇒ `missing_key`, no request. */
  apiKey: string | null | undefined;
  /** Keep it small: accuracy falls as irrelevant state grows. */
  state: string | Record<string, unknown> | unknown[];
  questions: Q;
  /** Default `JEV_MODEL`. */
  model?: string;
  /** Whole-call deadline across all attempts (default 5s). */
  timeoutMs?: number;
  /** Count the deadline and latency from this instant (per `now`) instead of from the call. */
  startedAt?: number;
  /** Per-attempt cap. Default: whatever is left of the deadline. When it fires, the attempt is retried. */
  attemptTimeoutMs?: number;
  /** Total attempts, 1–5 (default 2: one retry). */
  maxAttempts?: number;
  /** Which HTTP statuses to retry (default `isRetryableStatus`). */
  retryable?: (status: number) => boolean;
  /** Base backoff; doubles per retry (default 250ms). */
  retryBackoffMs?: number;
  minRetryBudgetMs?: number;
  /** Extra headers, e.g. OpenRouter attribution (`http-referer`, `x-title`). */
  headers?: Record<string, string>;
  /** Receipt sink, called once per call that reached the network. Fire-and-forget. */
  onUsage?: UsageSink;
  /** Stamped on the receipt. */
  decisionId?: string;
  /** Test seams. */
  fetch?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function isAbortLike(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function bodyText(body: unknown): string {
  if (body === undefined || body === null) return '';
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/** The optional peer `decide` runs on. Declared in `peerDependencies` (optional). */
export const DECIDE_SDK_PACKAGE = '@typesafe-ai/sdk';

type Sdk = typeof import('@typesafe-ai/sdk');
let sdkLoad: Promise<Sdk> | null = null;

/**
 * Import the SDK on first use. A failed import is not cached, so installing
 * the peer (or a transient loader error) recovers without a restart.
 */
function loadSdk(): Promise<Sdk> {
  sdkLoad ??= import('@typesafe-ai/sdk').catch((e: unknown) => {
    sdkLoad = null;
    throw e;
  });
  return sdkLoad;
}

function makeClient(sdk: Sdk, apiKey: string, model: string, fetcher: Fetcher, headers: Record<string, string>): TypeSafeClient {
  return new sdk.TypeSafeClient({
    apiKey,
    baseURL: DECIDE_BASE_URL,
    defaultModel: model,
    logLevel: 'warn',
    retry: { maxRetries: 0 },
    defaultHeaders: { ...headers },
    fetch: fetcher as unknown as Fetch,
  });
}

/** Map an SDK throw to an error kind. `retryable` feeds our own retry loop. */
function mapSdkError(
  sdk: Sdk,
  e: unknown,
  timeoutMs: number,
  retryable: (status: number) => boolean,
  attemptCapped: boolean,
): { error: DecideError; retryable: boolean } {
  const { APIError, APIConnectionError, APITimeoutError, APIUserAbortError } = sdk;
  if (e instanceof APIError) {
    if (e.status === 429) {
      const retryAfter = Number(e.headers.get('retry-after'));
      return {
        error: { kind: 'rate_limited', ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}) },
        retryable: retryable(429),
      };
    }
    return {
      error: { kind: 'provider_error', status: e.status, body: bodyText(e.body).slice(0, 500) },
      retryable: retryable(e.status),
    };
  }
  // The SDK's per-attempt timer is set to our attempt budget, so its timeout is
  // ours. It is only worth retrying when a per-attempt cap fired with deadline
  // left; when the whole deadline fired, there is nothing left to retry in.
  if (e instanceof APITimeoutError || e instanceof APIUserAbortError || isAbortLike(e) ||
      (e instanceof APIConnectionError && isAbortLike((e as { cause?: unknown }).cause))) {
    return { error: { kind: 'timeout', timeoutMs }, retryable: attemptCapped };
  }
  if (e instanceof APIConnectionError) {
    const cause = (e as { cause?: unknown }).cause;
    return {
      error: { kind: 'transport', message: cause instanceof Error ? cause.message : e.message },
      retryable: true,
    };
  }
  // Anything else (e.g. the SDK's own local validation) is never retried.
  return { error: { kind: 'transport', message: e instanceof Error ? e.message : String(e) }, retryable: false };
}

/** Make one decision call. See the module docstring for the contract. */
export async function decide<Q extends DecisionQuestions>(params: DecideParams<Q>): Promise<DecideResult<Q>> {
  const now = params.now ?? (() => Date.now());
  const started = params.startedAt ?? now();
  const fetcher = params.fetch ?? fetch;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const timeoutMs = params.timeoutMs ?? DEFAULT_DECIDE_TIMEOUT_MS;
  const maxAttempts = Math.min(5, Math.max(1, Math.floor(params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)));
  const retryable = params.retryable ?? isRetryableStatus;
  const backoff = params.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const minRetryBudget = params.minRetryBudgetMs ?? DEFAULT_MIN_RETRY_BUDGET_MS;
  const model = params.model ?? JEV_MODEL;

  const finish = (result: DecideResult<Q>): DecideResult<Q> => {
    if (result.attempts > 0) emitReceipt(params.onUsage, toDecisionReceipt(result, { model, decisionId: params.decisionId }));
    return result;
  };
  const fail = (error: DecideError, attempts: number): DecideResult<Q> =>
    finish({ ok: false, error, latencyMs: now() - started, attempts });

  const invalid = validateDecisionRequest(params.state, params.questions);
  if (invalid) return fail({ kind: 'invalid_request', message: invalid }, 0);
  if (!params.apiKey) return fail({ kind: 'missing_key' }, 0);

  let sdk: Sdk;
  try {
    sdk = await loadSdk();
  } catch (e) {
    return fail({ kind: 'sdk_missing', message: e instanceof Error ? e.message : String(e) }, 0);
  }

  let client: TypeSafeClient;
  try {
    client = makeClient(sdk, params.apiKey, model, fetcher, params.headers ?? {});
  } catch (e) {
    return fail({ kind: 'transport', message: e instanceof Error ? e.message : String(e) }, 0);
  }

  let attempts = 0;
  let lastError: DecideError = { kind: 'transport', message: 'not attempted' };

  while (attempts < maxAttempts) {
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) return fail({ kind: 'timeout', timeoutMs }, attempts);
    if (attempts > 0 && remaining < minRetryBudget) break;
    attempts++;

    const attemptCapped = params.attemptTimeoutMs !== undefined && params.attemptTimeoutMs < remaining;
    const budget = attemptCapped ? params.attemptTimeoutMs! : remaining;

    let data: unknown;
    try {
      // `timeout` is per attempt in the SDK; bounding it by the attempt budget
      // makes the whole call bounded. The signal is belt and braces.
      data = await client.systemOne(
        { model, state: params.state as never, questions: params.questions as never },
        { timeout: budget, signal: AbortSignal.timeout(budget) },
      );
    } catch (e) {
      const mapped = mapSdkError(sdk, e, timeoutMs, retryable, attemptCapped);
      lastError = mapped.error;
      if (!mapped.retryable) return fail(lastError, attempts);
      if (attempts < maxAttempts) await sleep(backoff * 2 ** (attempts - 1));
      continue;
    }

    // The SDK hands back text when a 2xx body is not JSON.
    if (!data || typeof data !== 'object') {
      return fail({ kind: 'parse', message: 'response was not JSON' }, attempts);
    }
    // OpenRouter adds `usage.cost` beyond the SDK's typed `Usage`; the SDK passes
    // the parsed body through untouched, so read it defensively.
    const d = data as { model?: unknown; answers?: unknown; usage?: Record<string, unknown> };
    const parsed = parseDecisionAnswers(params.questions, d.answers);
    if (!parsed.ok) return fail({ kind: 'parse', message: parsed.message }, attempts);

    const cost = d.usage?.cost;
    return finish({
      ok: true,
      answers: parsed.answers,
      model: typeof d.model === 'string' ? d.model : model,
      usage: {
        inputTokens: Number(d.usage?.input_tokens) || 0,
        outputTokens: Number(d.usage?.output_tokens) || 0,
        costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
      },
      latencyMs: now() - started,
      attempts,
    });
  }

  return fail(lastError, attempts);
}

// ══ Modes and gating ══════════════════════════════════════════════════════════

/**
 * Modes and per-question gating. Pure.
 *
 * - `shadow`: answers are recorded (through `onDecision`) and never acted on.
 *   Every answered question comes back `suggested`.
 * - `gated`: act only at or above the question's threshold, which is required
 *   and must come from a held-out eval. Below it, `suggested`.
 * - `live`: act on every answer at or above the threshold, if one is set
 *   (default 0). For add-only uses, such as "hold this back from auto-dismiss",
 *   where acting can only make the app more careful.
 *
 * Confidence per type: `choice` and `score` use the provider's `confidence`.
 * A `noul` has none, so its confidence is `max(p, 1 - p)` and its value is
 * `p >= 0.5`: a noul threshold of 0.6 applies "yes" at p ≥ 0.6 and "no" at
 * p ≤ 0.4. Thresholds never transfer between questions or types.
 */

export type DecisionMode = 'shadow' | 'gated' | 'live';
export const DECISION_MODES: readonly DecisionMode[] = ['shadow', 'gated', 'live'];

/** What a caller may act on: a label, a (fractional) level index, or yes/no. */
export type ValueFor<Q> =
  Q extends ChoiceQuestion<infer L> ? L
  : Q extends ScoreQuestion ? number
  : Q extends NoulQuestion ? boolean
  : never;

export type QuestionOutcome<Q extends DecisionQuestion = DecisionQuestion> =
  | { status: 'applied'; value: ValueFor<Q>; confidence: number; answer: AnswerFor<Q> }
  | { status: 'suggested'; reason: 'shadow' | 'below_threshold'; value: ValueFor<Q>; confidence: number; answer: AnswerFor<Q> }
  | { status: 'skipped'; reason: 'error'; error: DecideError };

export type DecisionOutcomes<Q extends DecisionQuestions> = { [K in keyof Q]: QuestionOutcome<Q[K]> };

export interface QuestionPolicy {
  mode: DecisionMode;
  /** Null only in `shadow` (never applies) or `live` with no threshold (applies all). */
  minConfidence: number | null;
}

/** The value and confidence of one answer, by question type. */
export function readAnswer(
  q: DecisionQuestion,
  a: AnswerFor<DecisionQuestion>,
): { value: string | number | boolean; confidence: number } {
  if (q.type === 'noul') {
    const p = (a as AnswerFor<NoulQuestion>).noul;
    return { value: p >= 0.5, confidence: Math.max(p, 1 - p) };
  }
  if (q.type === 'score') {
    const s = a as AnswerFor<ScoreQuestion>;
    return { value: s.score, confidence: s.confidence };
  }
  const c = a as AnswerFor<ChoiceQuestion>;
  return { value: c.choice, confidence: c.confidence };
}

/** One question's outcome under its policy. */
export function gateAnswer<Q extends DecisionQuestion>(
  q: Q,
  answer: AnswerFor<Q>,
  policy: QuestionPolicy,
): QuestionOutcome<Q> {
  const { value, confidence } = readAnswer(q, answer as AnswerFor<DecisionQuestion>);
  const base = { value: value as ValueFor<Q>, confidence, answer };
  if (policy.mode === 'shadow') return { status: 'suggested', reason: 'shadow', ...base };
  const min = policy.minConfidence ?? (policy.mode === 'live' ? 0 : Infinity);
  return confidence >= min ? { status: 'applied', ...base } : { status: 'suggested', reason: 'below_threshold', ...base };
}

/** Every question's outcome. A failed call skips every question with the call's error. */
export function applyDecisionPolicy<Q extends DecisionQuestions>(
  questions: Q,
  result: DecideResult<Q>,
  policyOf: (name: keyof Q & string) => QuestionPolicy,
): DecisionOutcomes<Q> {
  const out: Record<string, QuestionOutcome> = {};
  for (const name of Object.keys(questions) as (keyof Q & string)[]) {
    out[name] = result.ok
      ? gateAnswer<DecisionQuestion>(questions[name] as DecisionQuestion, result.answers[name] as AnswerFor<DecisionQuestion>, policyOf(name))
      : { status: 'skipped', reason: 'error', error: result.error };
  }
  return out as DecisionOutcomes<Q>;
}

// ══ Worker pool ═══════════════════════════════════════════════════════════════

/**
 * A bounded worker pool for fan-out. Jev takes one state per request, so N
 * items are N calls; OpenRouter's documented ceiling is ~1,200 requests/min,
 * and ~8 workers keeps a cron well inside it.
 *
 * The whole run has one budget. A worker never starts an item after the budget
 * is spent, and an item still running when it ends is abandoned (reported
 * `timed_out`), so the pool returns within `budgetMs` whatever the workers do.
 * Never throws: a worker that throws is reported `error` for that item only.
 */

export const DEFAULT_POOL_CONCURRENCY = 8;

export type PoolResult<R> =
  | { status: 'done'; value: R }
  | { status: 'error'; error: unknown }
  /** Started, but the run budget ended first. */
  | { status: 'timed_out' }
  /** Never started: the run budget was already spent. */
  | { status: 'not_started' };

export interface PoolOptions {
  /** Default 8. */
  concurrency?: number;
  /** Whole-run budget. Default: unbounded. */
  budgetMs?: number;
  now?: () => number;
}

/** What a worker is told about the time it has left. */
export interface PoolTaskContext {
  /** ms left in the run budget (Infinity when unbounded). Pass it down as the call's `timeoutMs` cap. */
  remainingMs: number;
  index: number;
}

/** Results are in item order. */
export async function runDecisionPool<T, R>(
  items: readonly T[],
  worker: (item: T, ctx: PoolTaskContext) => Promise<R>,
  opts: PoolOptions = {},
): Promise<PoolResult<R>[]> {
  const now = opts.now ?? (() => Date.now());
  const deadline = opts.budgetMs === undefined ? Infinity : now() + Math.max(0, opts.budgetMs);
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_POOL_CONCURRENCY));
  const results: PoolResult<R>[] = items.map(() => ({ status: 'not_started' }));
  let next = 0;

  const runOne = async (index: number): Promise<void> => {
    const remainingMs = deadline - now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = worker(items[index], { remainingMs, index }).then(
        (value): PoolResult<R> => ({ status: 'done', value }),
        (error): PoolResult<R> => ({ status: 'error', error }),
      );
      if (remainingMs === Infinity) {
        results[index] = await work;
        return;
      }
      const outOfTime = new Promise<PoolResult<R>>(resolve => {
        timer = setTimeout(() => resolve({ status: 'timed_out' }), Math.max(0, remainingMs));
      });
      results[index] = await Promise.race([work, outOfTime]);
    } catch (error) {
      // A worker that throws synchronously.
      results[index] = { status: 'error', error };
    } finally {
      clearTimeout(timer);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length && now() < deadline) {
        await runOne(next++);
      }
    }),
  );
  return results;
}

// ══ defineDecision: versioning and fingerprints ═══════════════════════════════

/**
 * `defineDecision`: a versioned, fingerprinted decision.
 *
 * Every change to what Jev is asked (instructions, labels, definitions, level
 * wording), to how answers are acted on (modes, thresholds) or to the model is
 * a new decision version. The fingerprint is a hash of all of that; an app's
 * test pins it with `expectDecisionPinned`, which fails until the author bumps
 * `promptVersion` and re-pins. The full `version` string
 * (`promptVersion|model|kit-<kit version>`) is what gets stamped on every
 * persisted row, so live metrics can be split by version.
 *
 * Generalised from money-app's `JEV_CLASSIFIER_VERSION` +
 * `JEV_CONFIG_FINGERPRINT` + fingerprint test.
 */

/** This package's version. `define.test.ts` asserts it matches package.json. */
export const KIT_VERSION = '0.6.0';

const ID_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;

type PerQuestion<Q, V> = Partial<Record<keyof Q & string, V>>;

export interface DecisionConfig<Q extends DecisionQuestions> {
  /** Stable id, namespaced by app: `app.decision_name`. */
  id: string;
  /** Bump when definitions, examples, modes or thresholds change: `2026-09-27.a`. */
  promptVersion: string;
  questions: Q;
  /** Default mode for every question. */
  mode: DecisionMode;
  /** Per-question mode overrides (e.g. one `live` add-only noul next to shadow choices). */
  modes?: PerQuestion<Q, DecisionMode>;
  /** One threshold for every question, or per question. Required for every `gated` question. */
  minConfidence?: number | PerQuestion<Q, number>;
  /** Default `JEV_MODEL`. Part of the fingerprint. */
  model?: string;
  /** Default per-call deadline (5s). Not part of the fingerprint. */
  timeoutMs?: number;
}

export interface DecisionRun<Q extends DecisionQuestions> {
  ok: boolean;
  decisionId: string;
  version: string;
  outcomes: DecisionOutcomes<Q>;
  result: DecideResult<Q>;
  /** Present when the call reached the network. Metadata only. */
  receipt: DecisionReceipt | null;
}

export type RunOptions<Q extends DecisionQuestions> =
  Omit<DecideParams<Q>, 'questions' | 'model' | 'decisionId'> & {
    /** Persist the run (shadow rows, suggestions). Awaited; a throw is swallowed. */
    onDecision?: (run: DecisionRun<Q>) => void | Promise<void>;
  };

export interface EachOptions<T, Q extends DecisionQuestions>
  extends Omit<RunOptions<Q>, 'state'>, Pick<PoolOptions, 'concurrency' | 'budgetMs'> {
  stateOf: (item: T) => DecideParams<Q>['state'];
}

export interface EachResult<T, Q extends DecisionQuestions> {
  items: { item: T; run: DecisionRun<Q> | null; pool: PoolResult<DecisionRun<Q>>['status'] }[];
  stats: {
    attempted: number;
    /** Calls that returned answers. */
    answered: number;
    /** Calls that returned an error. */
    failed: number;
    /** Items the budget ended before or during. */
    unfinished: number;
    costUsd: number;
  };
}

export interface Decision<Q extends DecisionQuestions> {
  readonly id: string;
  readonly promptVersion: string;
  readonly model: string;
  /** `${promptVersion}|${model}|kit-${KIT_VERSION}`. Stamp it on every persisted row. */
  readonly version: string;
  /** 12 hex chars over questions, modes, thresholds and model. Pin it with `expectDecisionPinned`. */
  readonly fingerprint: string;
  readonly questions: Q;
  policyOf(name: keyof Q & string): QuestionPolicy;
  /** One call for one state. Never throws. */
  run(opts: RunOptions<Q>): Promise<DecisionRun<Q>>;
  /** Fan out over items with a worker pool and a run budget. Never throws. */
  runEach<T>(items: readonly T[], opts: EachOptions<T, Q>): Promise<EachResult<T, Q>>;
}

// ── Fingerprint ──────────────────────────────────────────────────────────────

/** JSON with object keys sorted at every level; array order is kept (score levels are ordered). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** FNV-1a 64-bit, first 12 hex chars. Pure and sync, so it runs anywhere. Not a security hash. */
export function shortHash(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(text);
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0').slice(0, 12);
}

/** The fingerprint of a config: what Jev is asked, how answers are acted on, and which model. */
export function decisionFingerprint<Q extends DecisionQuestions>(config: DecisionConfig<Q>): string {
  const policies = Object.fromEntries(Object.keys(config.questions).map(name => [name, resolvePolicy(config, name)]));
  return shortHash(canonicalJson({ questions: config.questions, policies, model: config.model ?? JEV_MODEL }));
}

function resolvePolicy<Q extends DecisionQuestions>(config: DecisionConfig<Q>, name: string): QuestionPolicy {
  const mode = (config.modes as Record<string, DecisionMode> | undefined)?.[name] ?? config.mode;
  const mc = config.minConfidence;
  const minConfidence = typeof mc === 'number' ? mc : ((mc as Record<string, number> | undefined)?.[name] ?? null);
  return { mode, minConfidence };
}

/**
 * Throws unless the decision still has the pinned fingerprint (and, when given,
 * version). Use in the app's test suite; works under any test runner.
 */
export function expectDecisionPinned(
  decision: Pick<Decision<DecisionQuestions>, 'id' | 'fingerprint' | 'version' | 'promptVersion'>,
  pinned: { fingerprint: string; version?: string },
): void {
  if (decision.fingerprint !== pinned.fingerprint) {
    throw new Error(
      `decision '${decision.id}' changed (fingerprint ${decision.fingerprint}, pinned ${pinned.fingerprint}). ` +
      `Its questions, modes, thresholds or model differ from the pinned version '${decision.promptVersion}'. ` +
      `Re-run its eval, bump promptVersion, then pin fingerprint '${decision.fingerprint}'.`,
    );
  }
  if (pinned.version !== undefined && decision.version !== pinned.version) {
    throw new Error(
      `decision '${decision.id}' version is '${decision.version}', pinned '${pinned.version}'. ` +
      'The model or kit release changed: re-run the eval before re-pinning.',
    );
  }
}

// ── defineDecision ───────────────────────────────────────────────────────────

/** Throws at definition time (startup / test) on a malformed config. */
export function defineDecision<const Q extends DecisionQuestions>(config: DecisionConfig<Q>): Decision<Q> {
  if (!ID_RE.test(config.id)) throw new Error(`decision id '${config.id}' must be namespaced, e.g. 'app.decision_name'`);
  if (!config.promptVersion || /[|\s]/.test(config.promptVersion)) {
    throw new Error(`decision '${config.id}': promptVersion must be non-empty with no spaces or '|'`);
  }
  const invalid = validateDecisionRequest('fingerprint', config.questions);
  if (invalid) throw new Error(`decision '${config.id}': ${invalid}`);
  const names = Object.keys(config.questions);
  const checkKeys = (label: string, map: object | undefined) => {
    for (const k of Object.keys(map ?? {})) {
      if (!names.includes(k)) throw new Error(`decision '${config.id}': ${label} names unknown question '${k}'`);
    }
  };
  checkKeys('modes', config.modes);
  if (typeof config.minConfidence === 'object') checkKeys('minConfidence', config.minConfidence);
  for (const name of names) {
    const p = resolvePolicy(config, name);
    if (!DECISION_MODES.includes(p.mode)) throw new Error(`decision '${config.id}': unknown mode '${p.mode}' for '${name}'`);
    if (p.minConfidence !== null && !(p.minConfidence >= 0 && p.minConfidence <= 1)) {
      throw new Error(`decision '${config.id}': threshold for '${name}' must be in [0, 1]`);
    }
    if (p.mode === 'gated' && p.minConfidence === null) {
      throw new Error(`decision '${config.id}': gated question '${name}' needs a minConfidence from a held-out eval`);
    }
  }

  const model = config.model ?? JEV_MODEL;
  const version = `${config.promptVersion}|${model}|kit-${KIT_VERSION}`;
  const policyOf = (name: keyof Q & string) => resolvePolicy(config, name);

  const run = async (opts: RunOptions<Q>): Promise<DecisionRun<Q>> => {
    const { onDecision, ...rest } = opts;
    const result = await decide<Q>({
      timeoutMs: config.timeoutMs ?? DEFAULT_DECIDE_TIMEOUT_MS,
      ...rest,
      questions: config.questions,
      model,
      decisionId: config.id,
    });
    const out: DecisionRun<Q> = {
      ok: result.ok,
      decisionId: config.id,
      version,
      outcomes: applyDecisionPolicy(config.questions, result, policyOf),
      result,
      receipt: result.attempts > 0 ? toDecisionReceipt(result, { model, decisionId: config.id }) : null,
    };
    if (onDecision) {
      try {
        await onDecision(out);
      } catch {
        // Persistence failures never fail the decision.
      }
    }
    return out;
  };

  const runEach = async <T>(items: readonly T[], opts: EachOptions<T, Q>): Promise<EachResult<T, Q>> => {
    const { stateOf, concurrency, budgetMs, ...runOpts } = opts;
    const perCall = runOpts.timeoutMs ?? config.timeoutMs ?? DEFAULT_DECIDE_TIMEOUT_MS;
    const pooled = await runDecisionPool(
      items,
      async (item, { remainingMs }) => run({ ...runOpts, state: stateOf(item), timeoutMs: Math.min(perCall, remainingMs) }),
      { concurrency, budgetMs, now: runOpts.now },
    );
    const stats = { attempted: items.length, answered: 0, failed: 0, unfinished: 0, costUsd: 0 };
    const rows = pooled.map((p, i) => {
      const r = p.status === 'done' ? p.value : null;
      if (r?.ok) stats.answered++;
      else if (r || p.status === 'error') stats.failed++;
      else stats.unfinished++;
      if (r?.result.ok) stats.costUsd += r.result.usage.costUsd ?? 0;
      return { item: items[i], run: r, pool: p.status };
    });
    stats.costUsd = Math.round(stats.costUsd * 1e9) / 1e9;
    return { items: rows, stats };
  };

  return Object.freeze({
    id: config.id,
    promptVersion: config.promptVersion,
    model,
    version,
    fingerprint: decisionFingerprint(config),
    questions: config.questions,
    policyOf,
    run,
    runEach,
  });
}

// ══ Offline eval ══════════════════════════════════════════════════════════════

/**
 * Offline eval: run a decision over labelled rows and report accuracy, and
 * accuracy and coverage at each confidence threshold. A generic version of
 * money-app's `scripts/jev-eval.ts` + `jev-metrics.ts`.
 *
 * The kit ships the harness; the app keeps its labelled data (never commit
 * personal rows) and its results. Tune wording on one half of the rows and
 * judge on the other: `split: 'even-odd'` reports both halves by id parity.
 * Pick a threshold from the held-out half's coverage table, not a round number.
 */

export const DEFAULT_EVAL_THRESHOLDS = [0.5, 0.7, 0.8, 0.9, 0.95] as const;

export type EvalSplit = 'all' | 'even-odd' | 'even' | 'odd';

export interface EvalPrediction {
  id: string | number;
  /** Ground truth as a string: a choice label, a score level index, or 'true'/'false'. */
  truth: string;
  pred: string | null;
  confidence: number | null;
  costUsd: number;
  latencyMs: number;
  error?: string;
}

export interface Rate {
  n: number;
  correct: number;
  /** correct / n, or null when n = 0. */
  rate: number | null;
}

export interface EvalSummary {
  n: number;
  errors: number;
  accuracy: Rate;
  /** Share of answered rows at or above each threshold, and their accuracy. */
  coverage: { threshold: number; coverage: number | null; accuracy: Rate }[];
  /** Precision/recall of what would be applied at `applyAt` (the decision's threshold, if any). */
  applyAt: number | null;
  perLabel: { label: string; support: number; predicted: number; precision: number | null; recall: number | null }[];
  confusions: { truth: string; pred: string; count: number; ids: (string | number)[] }[];
  costUsd: number;
  costPer1k: number | null;
  latencyMs: { p50: number | null; p90: number | null };
}

export interface EvalReport {
  decisionId: string;
  version: string;
  fingerprint: string;
  question: string;
  split: EvalSplit;
  predictions: EvalPrediction[];
  /** Over every scored row (`even`/`odd` splits: only that half). */
  summary: EvalSummary;
  /** `even-odd` only. */
  halves?: { even: EvalSummary; odd: EvalSummary };
}

const rate = (correct: number, n: number): Rate => ({ n, correct, rate: n ? correct / n : null });

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** Pure scoring. Rows with an error or no prediction count in `errors`, not in accuracy. */
export function summarizeDecisionEval(
  rows: readonly EvalPrediction[],
  opts: { thresholds?: readonly number[]; applyAt?: number | null; topConfusions?: number } = {},
): EvalSummary {
  const ok = rows.filter(r => !r.error && r.pred !== null);
  const right = (r: EvalPrediction) => r.pred === r.truth;

  const coverage = (opts.thresholds ?? DEFAULT_EVAL_THRESHOLDS).map(threshold => {
    const hi = ok.filter(r => (r.confidence ?? 0) >= threshold);
    return { threshold, coverage: ok.length ? hi.length / ok.length : null, accuracy: rate(hi.filter(right).length, hi.length) };
  });

  const applyAt = opts.applyAt ?? null;
  const applied = ok.filter(r => (r.confidence ?? 0) >= (applyAt ?? 0));
  const labels = [...new Set([...ok.map(r => r.truth), ...applied.map(r => r.pred!)])].sort();
  const perLabel = labels.map(label => {
    const support = ok.filter(r => r.truth === label).length;
    const predicted = applied.filter(r => r.pred === label);
    const tp = predicted.filter(right).length;
    return {
      label,
      support,
      predicted: predicted.length,
      precision: predicted.length ? tp / predicted.length : null,
      recall: support ? tp / support : null,
    };
  });

  const byPair = new Map<string, { truth: string; pred: string; ids: (string | number)[] }>();
  for (const r of ok.filter(r => !right(r))) {
    const key = `${r.truth}\u0000${r.pred}`;
    const e = byPair.get(key) ?? { truth: r.truth, pred: r.pred!, ids: [] };
    e.ids.push(r.id);
    byPair.set(key, e);
  }
  const confusions = [...byPair.values()]
    .map(e => ({ ...e, count: e.ids.length }))
    .sort((a, b) => b.count - a.count || a.truth.localeCompare(b.truth))
    .slice(0, opts.topConfusions ?? 15);

  const costUsd = rows.reduce((s, r) => s + (r.costUsd || 0), 0);
  const answered = rows.filter(r => !r.error);
  return {
    n: rows.length,
    errors: rows.length - ok.length,
    accuracy: rate(ok.filter(right).length, ok.length),
    coverage,
    applyAt,
    perLabel,
    confusions,
    costUsd,
    costPer1k: answered.length ? (1000 * costUsd) / answered.length : null,
    latencyMs: { p50: percentile(answered.map(r => r.latencyMs), 50), p90: percentile(answered.map(r => r.latencyMs), 90) },
  };
}

/** Parity of an id: numbers by value, strings by a stable hash. */
export function idParity(id: string | number): 'even' | 'odd' {
  if (typeof id === 'number') return Math.abs(Math.trunc(id)) % 2 === 0 ? 'even' : 'odd';
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (h & 1) === 0 ? 'even' : 'odd';
}

/** A prediction value as the string the truth label is compared to. Scores round to the nearest level. */
export function predictionLabel(q: DecisionQuestion, a: AnswerFor<DecisionQuestion>): { pred: string; confidence: number } {
  const { value, confidence } = readAnswer(q, a);
  return { pred: q.type === 'score' ? String(Math.round(value as number)) : String(value), confidence };
}

export interface RunEvalParams<T, Q extends DecisionQuestions> {
  decision: Decision<Q>;
  rows: readonly T[];
  stateOf: (row: T) => RunOptions<Q>['state'];
  /** The ground truth for the scored question: a label, a level index, or a boolean. */
  labelOf: (row: T) => string | number | boolean;
  idOf: (row: T) => string | number;
  /** Which question to score. Default: the decision's only question. */
  question?: keyof Q & string;
  split?: EvalSplit;
  thresholds?: readonly number[];
  /** Everything a run needs: apiKey, and test seams. */
  run: Omit<RunOptions<Q>, 'state' | 'onDecision'>;
  concurrency?: number;
  budgetMs?: number;
}

/** Run the decision over labelled rows and score one question. Never throws on a failed call. */
export async function runDecisionEval<T, Q extends DecisionQuestions>(params: RunEvalParams<T, Q>): Promise<EvalReport> {
  const { decision } = params;
  const names = Object.keys(decision.questions) as (keyof Q & string)[];
  const question = params.question ?? (names.length === 1 ? names[0] : undefined);
  if (!question || !names.includes(question)) {
    throw new Error(`runDecisionEval: name the question to score (one of ${names.join(', ')})`);
  }
  const q = decision.questions[question] as DecisionQuestion;
  const split = params.split ?? 'all';
  const scored = params.rows.filter(r => split === 'all' || split === 'even-odd' || idParity(params.idOf(r)) === split);

  const each = await decision.runEach(scored, {
    ...params.run,
    stateOf: params.stateOf,
    concurrency: params.concurrency,
    budgetMs: params.budgetMs,
  });

  const predictions: EvalPrediction[] = each.items.map(({ item, run, pool }) => {
    const base = { id: params.idOf(item), truth: String(params.labelOf(item)) };
    if (!run) return { ...base, pred: null, confidence: null, costUsd: 0, latencyMs: 0, error: pool };
    if (!run.result.ok) {
      return { ...base, pred: null, confidence: null, costUsd: 0, latencyMs: run.result.latencyMs, error: run.result.error.kind };
    }
    const { pred, confidence } = predictionLabel(q, run.result.answers[question] as AnswerFor<DecisionQuestion>);
    return { ...base, pred, confidence, costUsd: run.result.usage.costUsd ?? 0, latencyMs: run.result.latencyMs };
  });

  const policy = decision.policyOf(question);
  const opts = { thresholds: params.thresholds, applyAt: policy.mode === 'shadow' ? null : policy.minConfidence };
  const report: EvalReport = {
    decisionId: decision.id,
    version: decision.version,
    fingerprint: decision.fingerprint,
    question,
    split,
    predictions,
    summary: summarizeDecisionEval(predictions, opts),
  };
  if (split === 'even-odd') {
    report.halves = {
      even: summarizeDecisionEval(predictions.filter(p => idParity(p.id) === 'even'), opts),
      odd: summarizeDecisionEval(predictions.filter(p => idParity(p.id) === 'odd'), opts),
    };
  }
  return report;
}

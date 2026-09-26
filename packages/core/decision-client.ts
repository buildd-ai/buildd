/**
 * Decision calls: a cheap, typed, calibrated "pick one of these" primitive.
 *
 * `inferenceCall` (./inference-client.ts) asks a generative model for JSON and
 * then has to extract and validate it. A lot of what buildd decides is not
 * generation at all — it is "which of these fixed labels fits this text?". For
 * that shape a System One model (Jev, by TypeSafe, served through OpenRouter)
 * returns a typed answer plus a full probability distribution and a
 * `confidence`, never prose, for a small fraction of a generative call's price
 * and latency. See `docs/design/decision-calls.md`.
 *
 * ## Contract
 *
 * - **Typed questions in, typed answers out.** `choice` (one of a fixed label
 *   set), `score` (an ordered 2–10 level rubric) and `noul` (probability of
 *   yes). The answer map is keyed by the same names as the question map and its
 *   types follow the question types.
 * - **Never throws.** Every failure is a `DecisionError` kind, so a caller can
 *   fall back to the logic it had before this call existed. A decision call is
 *   an accelerator, never a dependency.
 * - **Bounded.** One overall deadline covers every attempt (default 5s), with at
 *   most one retry on a transient failure (429 / 5xx / 529 / network) and only
 *   if the deadline still has room. There is no way to make this block for
 *   minutes.
 * - **Gated before spend.** The team's inference capability allowlist
 *   (`teams.enabledInferenceCapabilities`) is checked before the key is even
 *   resolved, exactly as `inferenceCall` does. Default empty ⇒ nothing runs.
 *
 * ## Credential
 *
 * An OpenRouter key in the `secrets` table (never a new table — see
 * `docs/credentials-architecture.md`) with purpose `decision_key`. An existing
 * `inference_key` row labelled `openrouter` is accepted as a fallback so a team
 * does not paste the same key twice. Resolution is most-specific-first:
 * account (the acting user's account) → workspace → team-wide. The
 * `OPENROUTER_API_KEY` env var is honoured **outside production only**, for
 * local development and the offline eval script.
 */

import { db } from './db';
import { secrets, teams } from './db/schema';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { decrypt } from './secrets';
import { isInferenceEnabled, type InferenceCapability } from './inference-policy';

/** OpenRouter's Decisions API. Verified against the published API reference. */
export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

/**
 * Pinned, not the `~typesafe/jev-latest` alias: confidence thresholds are tuned
 * against one version, and an alias can move under them. Bump deliberately,
 * after re-running the offline eval.
 */
export const DEFAULT_DECISION_MODEL = 'typesafe/jev-1.13';

/** Secret purpose holding an OpenRouter key for decision calls. */
export const DECISION_KEY_PURPOSE = 'decision_key' as const;

/** Whole-call ceiling across all attempts. */
export const DEFAULT_DECISION_TIMEOUT_MS = 5_000;

/**
 * Jev's hard limit is 32K tokens for `state` plus the longest question. This is
 * a conservative *estimate* (≈3 chars/token) so a request that would be refused
 * upstream is refused locally, for free.
 */
export const MAX_DECISION_TOKENS = 32_000;
const CHARS_PER_TOKEN_ESTIMATE = 3;

export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

const RETRY_BACKOFF_MS = 250;
/** Don't start a retry with less than this much deadline left. */
const MIN_RETRY_BUDGET_MS = 500;

// ── Question and answer types ─────────────────────────────────────────────────

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

export type DecisionError =
  | { kind: 'capability_disabled'; capability: InferenceCapability }
  | { kind: 'missing_key' }
  | { kind: 'invalid_request'; message: string }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'transport'; message: string }
  | { kind: 'rate_limited'; retryAfter?: number }
  | { kind: 'provider_error'; status: number; body: string }
  | { kind: 'parse'; message: string };

export type DecisionResult<Q extends DecisionQuestions> =
  | {
      ok: true;
      answers: DecisionAnswers<Q>;
      /** The versioned model that answered (log it next to any threshold). */
      model: string;
      usage: DecisionUsage;
      latencyMs: number;
      attempts: number;
    }
  | { ok: false; error: DecisionError; latencyMs: number; attempts: number };

export function describeDecisionError(error: DecisionError): string {
  switch (error.kind) {
    case 'capability_disabled':
      return `decision calls are not enabled for '${error.capability}' on this team`;
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
  }
}

// ── Local request validation (free — refuses what upstream would refuse) ──────

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
      if (n < 2) return `choice '${name}' needs at least 2 labels`;
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
 * the caller's label set is a parse failure, not a new label — the whole point
 * of a closed set is that code can switch on it exhaustively.
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

// ── Confidence gating ────────────────────────────────────────────────────────

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

// ── Key resolution ───────────────────────────────────────────────────────────

const KEY_PURPOSES = [DECISION_KEY_PURPOSE, 'inference_key'] as const;

export async function resolveDecisionKey(opts: {
  teamId: string;
  workspaceId?: string | null;
  accountId?: string | null;
}): Promise<string | null> {
  try {
    const rows = await db.query.secrets.findMany({
      where: and(
        eq(secrets.teamId, opts.teamId),
        or(...KEY_PURPOSES.map(p => eq(secrets.purpose, p as never))),
        or(isNull(secrets.accountId), opts.accountId ? eq(secrets.accountId, opts.accountId) : sql`false`),
        or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
      ),
      columns: {
        id: true, purpose: true, label: true, encryptedValue: true, accountId: true,
        workspaceId: true, healthStatus: true, updatedAt: true,
      },
    });

    // Re-checked in JS rather than trusted to the `where`: a key must never be
    // sent to a provider it was not issued for, and must never cross into
    // another account's or workspace's scope.
    const candidates = rows.filter(r =>
      (KEY_PURPOSES as readonly string[]).includes(r.purpose) &&
      (r.purpose === DECISION_KEY_PURPOSE || (r.label ?? '').toLowerCase() === 'openrouter') &&
      (r.accountId == null || r.accountId === opts.accountId) &&
      (r.workspaceId == null || r.workspaceId === opts.workspaceId),
    );

    // user → workspace → team, then the dedicated purpose, healthy over revoked,
    // newest first.
    const scopeRank = (r: { accountId: string | null; workspaceId: string | null }) =>
      r.accountId ? 0 : r.workspaceId ? 1 : 2;
    const best = candidates.sort((a, b) =>
      scopeRank(a) - scopeRank(b) ||
      KEY_PURPOSES.indexOf(a.purpose as never) - KEY_PURPOSES.indexOf(b.purpose as never) ||
      ((a.healthStatus as string) === 'revoked' ? 1 : 0) - ((b.healthStatus as string) === 'revoked' ? 1 : 0) ||
      (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
    )[0];

    if (best) {
      try {
        const value = decrypt(best.encryptedValue);
        if (value) return value;
      } catch (e) {
        console.error(`[decision] failed to decrypt secret ${best.id}:`, e);
      }
    }
  } catch (e) {
    console.warn('[decision] key lookup failed:', e);
  }

  // Dev-only fallback. In production the key must live in `secrets`, so a
  // stray env var can never silently start spending on every team.
  if (process.env.NODE_ENV !== 'production') return process.env.OPENROUTER_API_KEY || null;
  return null;
}

/** Fails closed: a failed lookup means "not enabled", never "spend anyway". */
async function teamAllowsCapability(teamId: string, capability: InferenceCapability): Promise<boolean> {
  try {
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { enabledInferenceCapabilities: true },
    });
    return isInferenceEnabled(capability, team?.enabledInferenceCapabilities ?? null);
  } catch (e) {
    console.warn(`[decision] capability lookup failed for team ${teamId}:`, e);
    return false;
  }
}

// ── Transport ────────────────────────────────────────────────────────────────

type Fetcher = typeof fetch;

/** Statuses worth one retry: rate limit, overload, gateway and edge timeouts. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface DecisionCallParams<Q extends DecisionQuestions> {
  /** Which call site — checked against the team allowlist before any spend. */
  capability: InferenceCapability;
  teamId: string;
  workspaceId?: string | null;
  /** The acting user's account, for account-scoped keys. */
  accountId?: string | null;
  /** Keep it small: accuracy falls as irrelevant state grows. */
  state: string | Record<string, unknown> | unknown[];
  questions: Q;
  model?: string;
  /** Whole-call deadline across all attempts (default 5s). */
  timeoutMs?: number;
  /** Pre-resolved key (the offline eval passes one; skips DB lookup + allowlist). */
  apiKey?: string;
  /** Test seams. */
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Make one decision call. See the module docstring for the contract.
 *
 * When `apiKey` is supplied the allowlist and key lookup are skipped — that path
 * exists for the offline eval script, which runs outside any team.
 */
export async function decisionCall<Q extends DecisionQuestions>(
  params: DecisionCallParams<Q>,
): Promise<DecisionResult<Q>> {
  const now = params.now ?? (() => Date.now());
  const started = now();
  const fetcher = params.fetcher ?? fetch;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const timeoutMs = params.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  const fail = (error: DecisionError, attempts: number): DecisionResult<Q> =>
    ({ ok: false, error, latencyMs: now() - started, attempts });

  const invalid = validateDecisionRequest(params.state, params.questions);
  if (invalid) return fail({ kind: 'invalid_request', message: invalid }, 0);

  let apiKey = params.apiKey ?? null;
  if (!apiKey) {
    if (!(await teamAllowsCapability(params.teamId, params.capability))) {
      return fail({ kind: 'capability_disabled', capability: params.capability }, 0);
    }
    apiKey = await resolveDecisionKey({
      teamId: params.teamId, workspaceId: params.workspaceId, accountId: params.accountId,
    });
    if (!apiKey) return fail({ kind: 'missing_key' }, 0);
  }

  const body = JSON.stringify({
    model: params.model ?? DEFAULT_DECISION_MODEL,
    state: params.state,
    questions: params.questions,
  });

  let attempts = 0;
  let lastError: DecisionError = { kind: 'transport', message: 'not attempted' };

  while (attempts < 2) {
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) return fail({ kind: 'timeout', timeoutMs }, attempts);
    if (attempts > 0 && remaining < MIN_RETRY_BUDGET_MS) break;
    attempts++;

    let res: Response;
    try {
      res = await fetcher(DECISIONS_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'http-referer': 'https://buildd.dev',
          'x-title': 'buildd',
        },
        body,
        signal: AbortSignal.timeout(remaining),
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') return fail({ kind: 'timeout', timeoutMs }, attempts);
      lastError = { kind: 'transport', message: e instanceof Error ? e.message : String(e) };
      if (attempts < 2) await sleep(RETRY_BACKOFF_MS);
      continue;
    }

    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        lastError = { kind: 'rate_limited', ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}) };
      } else {
        const text = await res.text().catch(() => '');
        lastError = { kind: 'provider_error', status: res.status, body: text.slice(0, 500) };
      }
      if (!isRetryableStatus(res.status)) return fail(lastError, attempts);
      if (attempts < 2) await sleep(RETRY_BACKOFF_MS);
      continue;
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      return fail({ kind: 'parse', message: 'response was not JSON' }, attempts);
    }
    const parsed = parseDecisionAnswers(params.questions, data?.answers);
    if (!parsed.ok) return fail({ kind: 'parse', message: parsed.message }, attempts);

    const cost = data?.usage?.cost;
    return {
      ok: true,
      answers: parsed.answers,
      model: typeof data?.model === 'string' ? data.model : (params.model ?? DEFAULT_DECISION_MODEL),
      usage: {
        inputTokens: Number(data?.usage?.input_tokens) || 0,
        outputTokens: Number(data?.usage?.output_tokens) || 0,
        costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
      },
      latencyMs: now() - started,
      attempts,
    };
  }

  return fail(lastError, attempts);
}

/**
 * Brokered model inference for an agent run (capability `model.inference`).
 *
 * A running agent's own script asks buildd to answer a bounded Jev-shaped
 * decision (choice / score / noul questions over a small state) with the
 * team's configured decision model. buildd holds the key and picks the
 * endpoint; the agent sees answers and a receipt, never a credential, a base
 * URL, or a provider response body. It is not an eval runner: the agent runs
 * its own script and dataset on its own runner and stores results as task
 * artifacts, exactly as it would any other output.
 *
 * Every request, in this order, before any provider call:
 *   1. the payload is bounded (operation, model id, question count, state size)
 *   2. a live grant exists for this principal (`ModelInferenceGrantSource`)
 *   3. the grant matches the principal (team, workspace, task, worker), is
 *      unexpired and unrevoked, and allows this operation and exact model
 *   4. the team's own key resolves through the shared decision route, for a
 *      model and provider the grant allows; buildd's platform key is never used
 *   5. the ledger reserves this call's worst case against the grant's budget
 *      (calls, tokens, dollars, concurrency)
 * Then exactly one provider attempt (no retry: one reservation, one request),
 * and the reservation is settled: the provider's reported cost, or the whole
 * reservation when the call reached the provider but the cost is missing or
 * the call failed. Missing metadata never makes a call free.
 *
 * Fails closed by construction: the grant source and the ledger are seams
 * whose defaults refuse. The generic grant service (capability-grants.ts,
 * mission task 0bfbe2dc) supplies the first; a durable per-grant ledger the
 * second. Until both are wired, every request is refused with zero spend.
 *
 * Spec: docs/specs/model-inference-agent-capability.md
 */
import {
  decide,
  estimateDecisionTokens,
  validateDecisionRequest,
  JEV_MODEL,
  MAX_DECISION_TOKENS,
  type DecideParams,
  type DecideResult,
  type DecisionAnswers,
  type DecisionEndpoint,
  type DecisionQuestions,
} from '@builddai/ai-kit/decide';
import type { AgentPrincipal } from '@/lib/agent-capabilities/principal';

export const MODEL_INFERENCE_CAPABILITY = 'model.inference' as const;

/** What an agent may ask for. `decide` = typed choice/score/noul questions (Jev's shape). */
export const MODEL_INFERENCE_OPERATIONS = ['decide'] as const;
export type ModelInferenceOperation = typeof MODEL_INFERENCE_OPERATIONS[number];

/** Who is paid. `openrouter`: the team's OpenRouter key. `litellm`: the team's gateway. `cloudflare`: Clef on the team's Cloudflare token. */
export type ModelInferenceProvider = 'openrouter' | 'litellm' | 'cloudflare';

// ── Platform ceilings (a grant may narrow these, never widen them) ───────────

export const MODEL_INFERENCE_LIMITS = Object.freeze({
  maxQuestions: 16,
  maxStateBytes: 64 * 1024,
  maxTokensPerCall: MAX_DECISION_TOKENS,
  maxTimeoutMs: 15_000,
  maxConcurrent: 8,
  /** No grant may authorise more than this per call or in total. */
  maxUsdPerCall: 1,
  maxUsdPerGrant: 100,
});

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

// ── The grant seam ───────────────────────────────────────────────────────────

/**
 * The budget a grant carries. All are hard ceilings; the ledger enforces the
 * running totals, this module the per-call ones.
 */
export interface ModelInferenceBudget {
  maxCalls: number;
  maxTokensPerCall: number;
  maxTotalTokens: number;
  /** Reserved per call before it runs; the worst case one call may cost. */
  maxUsdPerCall: number;
  /** Dollar ceiling across the grant's life. */
  maxUsd: number;
  timeoutMs: number;
  maxConcurrent: number;
}

/**
 * A live, approved, task-scoped grant of `model.inference`, as the generic
 * grant service must hand it over. Every field is re-checked here on every
 * request: a grant service bug cannot widen what this module allows.
 */
export interface ModelInferenceGrant {
  grantId: string;
  capability: typeof MODEL_INFERENCE_CAPABILITY;
  teamId: string;
  workspaceId: string;
  taskId: string;
  workerId: string;
  provider: ModelInferenceProvider;
  /** Exact model ids; no globs, no aliases. */
  models: readonly string[];
  operations: readonly ModelInferenceOperation[];
  expiresAt: Date;
  revokedAt: Date | null;
  budget: ModelInferenceBudget;
}

/**
 * Where live grants come from. The generic grant service implements this; it
 * returns the principal's live grant for the capability, or null. It must not
 * return a grant for another principal, but this module checks anyway.
 */
export interface ModelInferenceGrantSource {
  findLiveGrant(q: { principal: AgentPrincipal; capability: typeof MODEL_INFERENCE_CAPABILITY }): Promise<ModelInferenceGrant | null>;
}

/** The default until the grant service ships: no grant exists, so nothing runs. */
export const NO_GRANT_SERVICE: ModelInferenceGrantSource = {
  findLiveGrant: async () => null,
};

// ── The ledger seam ──────────────────────────────────────────────────────────

export type ReserveRefusal =
  | 'ledger_unavailable'
  | 'calls_exhausted'
  | 'tokens_exhausted'
  | 'budget_exhausted'
  | 'concurrency_limit';

export interface ModelInferenceReservation {
  grantId: string;
  reservationId: string;
  usd: number;
  tokens: number;
}

export interface ModelInferenceSettlement {
  grantId: string;
  reservationId: string;
  /** What is debited: the provider's cost, or the full reservation when that is unknown. */
  debitUsd: number;
  tokens: number;
  costSource: 'provider' | 'reservation' | 'none';
  outcome: 'ok' | 'error' | 'not_sent';
}

/**
 * Per-grant spend accounting. `reserve` must be atomic against concurrent
 * callers (one conditional UPDATE … RETURNING, never read-then-write) and
 * count the reservation toward calls, tokens, dollars and in-flight calls.
 * `settle` replaces the reservation with the debit and frees the slot.
 */
export interface ModelInferenceLedger {
  reserve(r: ModelInferenceReservation, budget: ModelInferenceBudget): Promise<{ ok: true } | { ok: false; reason: ReserveRefusal }>;
  settle(s: ModelInferenceSettlement): Promise<void>;
}

/** The default until a durable ledger exists: refuse, never pretend. */
export const NO_LEDGER: ModelInferenceLedger = {
  reserve: async () => ({ ok: false, reason: 'ledger_unavailable' }),
  settle: async () => {},
};

/** Running totals a ledger keeps per grant. */
export interface GrantUsage {
  calls: number;
  tokens: number;
  usd: number;
  inFlight: number;
}

/**
 * The rule every ledger applies on `reserve`, pure so each implementation and
 * its tests share it. Reservations count as spent until settled.
 */
export function reserveRefusal(usage: GrantUsage, budget: ModelInferenceBudget, ask: { usd: number; tokens: number }): ReserveRefusal | null {
  if (usage.inFlight + 1 > budget.maxConcurrent) return 'concurrency_limit';
  if (usage.calls + 1 > budget.maxCalls) return 'calls_exhausted';
  if (usage.tokens + ask.tokens > budget.maxTotalTokens) return 'tokens_exhausted';
  if (usage.usd + ask.usd > budget.maxUsd + 1e-12) return 'budget_exhausted';
  return null;
}

// ── The route seam ───────────────────────────────────────────────────────────

/**
 * The team's decision route, already resolved with the team's own key. The
 * endpoint is buildd's constant OpenRouter URL or the team admin's gateway,
 * never anything from the request.
 */
export interface ResolvedInferenceRoute {
  apiKey: string;
  provider: ModelInferenceProvider;
  model: string;
  endpoint?: DecisionEndpoint;
  /** For a gateway: a fetcher that refuses non-public addresses. */
  fetch?: typeof fetch;
}

export type RouteResolver = (scope: { teamId: string; workspaceId: string; accountId: string }) => Promise<ResolvedInferenceRoute | null>;

// ── Request / result ─────────────────────────────────────────────────────────

export interface ModelInferenceRequest {
  operation: ModelInferenceOperation;
  model: string;
  state: string | Record<string, unknown> | unknown[];
  questions: DecisionQuestions;
}

export type ModelInferenceRefusalCode =
  | 'invalid_request'
  | 'no_team'
  | 'no_grant'
  | 'grant_mismatch'
  | 'grant_expired'
  | 'grant_revoked'
  | 'operation_not_allowed'
  | 'model_not_allowed'
  | 'provider_not_allowed'
  | 'budget_invalid'
  | 'tokens_over_limit'
  | 'missing_key'
  | ReserveRefusal;

/** What the agent is shown about a call that ran. No key, URL or provider body. */
export interface ModelInferenceReceipt {
  grantId: string;
  provider: ModelInferenceProvider;
  /** The versioned model that answered (or was asked, on failure). */
  model: string;
  operation: ModelInferenceOperation;
  inputTokens: number;
  outputTokens: number;
  /** The provider's reported cost; null when it reported none. */
  costUsd: number | null;
  /** What the grant was charged. Equals the reservation when cost is unknown. */
  debitedUsd: number;
  costSource: ModelInferenceSettlement['costSource'];
  latencyMs: number;
}

export type ModelInferenceResult =
  | { ok: true; answers: DecisionAnswers<DecisionQuestions>; receipt: ModelInferenceReceipt }
  | { ok: false; status: 400 | 403 | 404 | 409 | 429 | 503; code: ModelInferenceRefusalCode; error: string; grantId?: string }
  | { ok: false; status: 502 | 504; code: 'provider_error' | 'rate_limited' | 'timeout' | 'transport' | 'parse' | 'uncalibrated'; error: string; receipt: ModelInferenceReceipt };

export interface ModelInferenceDeps {
  grants: ModelInferenceGrantSource;
  ledger: ModelInferenceLedger;
  resolveRoute: RouteResolver;
  decide: <Q extends DecisionQuestions>(p: DecideParams<Q>) => Promise<DecideResult<Q>>;
  /** Fire-and-forget audit sink; never given credential material. */
  audit: (row: ModelInferenceAudit) => void;
  now?: () => Date;
  newId?: () => string;
}

export interface ModelInferenceAudit {
  decision: 'allowed' | 'refused';
  reasonCode: string | null;
  grantId: string | null;
  expiresAt: Date | null;
  sideEffect: Record<string, unknown> | null;
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Shape and size checks on an untrusted body. Returns the request or why not. */
export function parseModelInferenceRequest(body: unknown): { ok: true; request: ModelInferenceRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  // Anything that could redirect the call or bring its own credential is refused outright, not ignored.
  for (const k of ['baseURL', 'baseUrl', 'endpoint', 'apiKey', 'api_key', 'headers', 'provider']) {
    if (k in b) return { ok: false, error: `'${k}' is not accepted: buildd chooses the endpoint and credential` };
  }
  const operation = b.operation ?? 'decide';
  if (!(MODEL_INFERENCE_OPERATIONS as readonly unknown[]).includes(operation)) {
    return { ok: false, error: `operation must be one of: ${MODEL_INFERENCE_OPERATIONS.join(', ')}` };
  }
  if (typeof b.model !== 'string' || !MODEL_ID_RE.test(b.model)) return { ok: false, error: 'model must be an exact model id' };
  const state = b.state;
  if (typeof state !== 'string' && (typeof state !== 'object' || state === null)) return { ok: false, error: 'state must be a string, object or array' };
  let stateBytes: number;
  try {
    stateBytes = Buffer.byteLength(typeof state === 'string' ? state : JSON.stringify(state), 'utf8');
  } catch {
    return { ok: false, error: 'state must be JSON-serialisable' };
  }
  if (stateBytes > MODEL_INFERENCE_LIMITS.maxStateBytes) return { ok: false, error: `state is over ${MODEL_INFERENCE_LIMITS.maxStateBytes} bytes` };
  const questions = b.questions;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) return { ok: false, error: 'questions must be an object' };
  const n = Object.keys(questions).length;
  if (n === 0 || n > MODEL_INFERENCE_LIMITS.maxQuestions) return { ok: false, error: `questions must hold 1–${MODEL_INFERENCE_LIMITS.maxQuestions} entries` };
  const invalid = validateDecisionRequest(state, questions as DecisionQuestions);
  if (invalid) return { ok: false, error: invalid };
  return {
    ok: true,
    request: { operation: operation as ModelInferenceOperation, model: b.model, state: state as ModelInferenceRequest['state'], questions: questions as DecisionQuestions },
  };
}

function budgetIsSane(b: ModelInferenceBudget | null | undefined): b is ModelInferenceBudget {
  if (!b) return false;
  const L = MODEL_INFERENCE_LIMITS;
  const pos = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max;
  return Number.isInteger(b.maxCalls) && b.maxCalls > 0
    && Number.isInteger(b.maxConcurrent) && pos(b.maxConcurrent, L.maxConcurrent)
    && pos(b.maxTokensPerCall, L.maxTokensPerCall)
    && pos(b.maxTotalTokens, Number.MAX_SAFE_INTEGER)
    && pos(b.maxUsdPerCall, L.maxUsdPerCall)
    && pos(b.maxUsd, L.maxUsdPerGrant)
    && b.maxUsdPerCall <= b.maxUsd
    && pos(b.timeoutMs, L.maxTimeoutMs);
}

/**
 * Does this grant authorise this principal to make this request? Pure, so the
 * rule is visible and tested; the provider/model match with the team's route
 * is checked separately, once the route is known.
 */
export function checkGrant(
  grant: ModelInferenceGrant,
  principal: AgentPrincipal,
  request: Pick<ModelInferenceRequest, 'operation' | 'model'>,
  now: Date,
): ModelInferenceRefusalCode | null {
  if (grant.capability !== MODEL_INFERENCE_CAPABILITY) return 'grant_mismatch';
  if (grant.teamId !== principal.teamId || grant.workspaceId !== principal.workspaceId
    || grant.taskId !== principal.taskId || grant.workerId !== principal.workerId) return 'grant_mismatch';
  if (grant.revokedAt) return 'grant_revoked';
  if (!(grant.expiresAt instanceof Date) || Number.isNaN(grant.expiresAt.getTime()) || grant.expiresAt.getTime() <= now.getTime()) return 'grant_expired';
  if (!grant.operations.includes(request.operation)) return 'operation_not_allowed';
  if (!grant.models.includes(request.model)) return 'model_not_allowed';
  if (!budgetIsSane(grant.budget)) return 'budget_invalid';
  return null;
}

// ── The call ─────────────────────────────────────────────────────────────────

const REFUSAL_STATUS: Record<ModelInferenceRefusalCode, 400 | 403 | 404 | 409 | 429 | 503> = {
  invalid_request: 400,
  no_team: 403,
  no_grant: 403,
  grant_mismatch: 403,
  grant_expired: 403,
  grant_revoked: 403,
  operation_not_allowed: 403,
  model_not_allowed: 403,
  provider_not_allowed: 403,
  budget_invalid: 409,
  tokens_over_limit: 400,
  missing_key: 409,
  ledger_unavailable: 503,
  calls_exhausted: 429,
  tokens_exhausted: 429,
  budget_exhausted: 429,
  concurrency_limit: 429,
};

const REFUSAL_TEXT: Record<ModelInferenceRefusalCode, string> = {
  invalid_request: 'The request is malformed',
  no_team: 'This run has no team to bill',
  no_grant: 'No live model.inference grant for this task',
  grant_mismatch: 'No live model.inference grant for this task',
  grant_expired: 'The model.inference grant has expired',
  grant_revoked: 'The model.inference grant was revoked',
  operation_not_allowed: 'The grant does not allow this operation',
  model_not_allowed: 'The grant does not allow this model',
  provider_not_allowed: "The team's configured model or provider is not one the grant allows",
  budget_invalid: 'The grant carries no valid budget',
  tokens_over_limit: 'The request is larger than the grant allows per call',
  missing_key: 'The team has no inference key configured for decisions',
  ledger_unavailable: 'Budget accounting is not available, so no call is made',
  calls_exhausted: 'The grant has used all its calls',
  tokens_exhausted: 'The grant has used all its tokens',
  budget_exhausted: "The grant's dollar budget is spent",
  concurrency_limit: 'Too many calls in flight on this grant',
};

/** Failure kinds that are known never to have reached the provider. */
const NOT_SENT = new Set(['invalid_request', 'missing_key', 'sdk_missing']);

export async function invokeModelInference(
  principal: AgentPrincipal,
  request: ModelInferenceRequest,
  deps: ModelInferenceDeps,
): Promise<ModelInferenceResult> {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  let grant: ModelInferenceGrant | null = null;

  const refuse = (code: ModelInferenceRefusalCode, side?: Record<string, unknown>): ModelInferenceResult => {
    deps.audit({
      decision: 'refused', reasonCode: code, grantId: grant?.grantId ?? null, expiresAt: grant?.expiresAt ?? null,
      sideEffect: { operation: request.operation, model: request.model, ...side },
    });
    return { ok: false, status: REFUSAL_STATUS[code], code, error: REFUSAL_TEXT[code], ...(grant ? { grantId: grant.grantId } : {}) };
  };

  if (!principal.teamId) return refuse('no_team');

  try {
    grant = await deps.grants.findLiveGrant({ principal, capability: MODEL_INFERENCE_CAPABILITY });
  } catch {
    grant = null; // a failed lookup is no grant
  }
  if (!grant) return refuse('no_grant');

  const mismatch = checkGrant(grant, principal, request, now());
  if (mismatch) return refuse(mismatch);
  const budget = grant.budget;

  const tokens = estimateDecisionTokens(request.state, request.questions);
  if (tokens > budget.maxTokensPerCall) return refuse('tokens_over_limit', { tokens });

  let route: ResolvedInferenceRoute | null;
  try {
    route = await deps.resolveRoute({ teamId: principal.teamId, workspaceId: principal.workspaceId, accountId: principal.accountId });
  } catch {
    route = null;
  }
  if (!route?.apiKey) return refuse('missing_key');
  // The team's configured route decides the model and who is paid; the grant must name both.
  if (route.provider !== grant.provider || route.model !== request.model) {
    return refuse(route.model !== request.model ? 'model_not_allowed' : 'provider_not_allowed', { routeModel: route.model, routeProvider: route.provider });
  }

  const reservation: ModelInferenceReservation = { grantId: grant.grantId, reservationId: newId(), usd: budget.maxUsdPerCall, tokens };
  let reserved: Awaited<ReturnType<ModelInferenceLedger['reserve']>>;
  try {
    reserved = await deps.ledger.reserve(reservation, budget);
  } catch {
    reserved = { ok: false, reason: 'ledger_unavailable' };
  }
  if (!reserved.ok) return refuse(reserved.reason);

  // The deadline never outlives the grant.
  const msLeft = grant.expiresAt.getTime() - now().getTime();
  const timeoutMs = Math.max(1, Math.min(budget.timeoutMs, MODEL_INFERENCE_LIMITS.maxTimeoutMs, msLeft));

  let result: DecideResult<DecisionQuestions>;
  try {
    result = await deps.decide({
      apiKey: route.apiKey,
      ...(route.endpoint ? { endpoint: route.endpoint } : {}),
      model: route.model,
      state: request.state,
      questions: request.questions,
      timeoutMs,
      maxAttempts: 1,
      headers: { 'http-referer': 'https://buildd.dev', 'x-title': 'buildd' },
      decisionId: `agent:${principal.taskId}`,
      ...(route.fetch ? { fetch: route.fetch } : {}),
    });
  } catch (e) {
    // `decide` never throws; if a replacement does, treat it as reaching the provider.
    result = { ok: false, error: { kind: 'transport', message: e instanceof Error ? e.message : 'unknown' }, latencyMs: 0, attempts: 1 };
  }

  const sent = result.ok || (result.attempts > 0 && !NOT_SENT.has(result.error.kind));
  const reportedCost = result.ok && typeof result.usage.costUsd === 'number' && Number.isFinite(result.usage.costUsd) && result.usage.costUsd >= 0
    ? result.usage.costUsd : null;
  const costSource: ModelInferenceSettlement['costSource'] = !sent ? 'none' : reportedCost !== null ? 'provider' : 'reservation';
  const debitUsd = costSource === 'none' ? 0 : costSource === 'provider' ? reportedCost! : reservation.usd;
  const usedTokens = result.ok ? result.usage.inputTokens + result.usage.outputTokens : sent ? tokens : 0;
  const outcome: ModelInferenceSettlement['outcome'] = !sent ? 'not_sent' : result.ok ? 'ok' : 'error';

  try {
    await deps.ledger.settle({ grantId: grant.grantId, reservationId: reservation.reservationId, debitUsd, tokens: usedTokens, costSource, outcome });
  } catch (e) {
    // The reservation stays held: the ledger over-counts rather than under-counts.
    console.warn(`[model-inference] settle failed for grant ${grant.grantId}: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`);
  }

  const receipt: ModelInferenceReceipt = {
    grantId: grant.grantId,
    provider: route.provider,
    model: result.ok ? result.model : route.model,
    operation: request.operation,
    inputTokens: result.ok ? result.usage.inputTokens : 0,
    outputTokens: result.ok ? result.usage.outputTokens : 0,
    costUsd: reportedCost,
    debitedUsd: debitUsd,
    costSource,
    latencyMs: result.latencyMs,
  };

  deps.audit({
    decision: result.ok ? 'allowed' : 'refused',
    reasonCode: result.ok ? null : `provider_${result.error.kind}`,
    grantId: grant.grantId,
    expiresAt: grant.expiresAt,
    sideEffect: { ...receipt, outcome },
  });

  if (result.ok) return { ok: true, answers: result.answers, receipt };

  const kind = result.error.kind;
  if (kind === 'missing_key') return { ok: false, status: 409, code: 'missing_key', error: REFUSAL_TEXT.missing_key, grantId: grant.grantId };
  if (kind === 'invalid_request') return { ok: false, status: 400, code: 'invalid_request', error: REFUSAL_TEXT.invalid_request, grantId: grant.grantId };
  // Provider bodies and transport messages are never relayed: they can echo request headers.
  const mapped = kind === 'timeout' ? { status: 504 as const, code: 'timeout' as const, error: 'The model did not answer in time' }
    : kind === 'rate_limited' ? { status: 502 as const, code: 'rate_limited' as const, error: 'The provider rate-limited the call' }
    : kind === 'provider_error' ? { status: 502 as const, code: 'provider_error' as const, error: `The provider returned HTTP ${result.error.status}` }
    : kind === 'parse' ? { status: 502 as const, code: 'parse' as const, error: 'The provider answer could not be read' }
    : kind === 'uncalibrated' ? { status: 502 as const, code: 'uncalibrated' as const, error: 'The model returned no confidence' }
    : { status: 502 as const, code: 'transport' as const, error: 'The provider could not be reached' };
  return { ok: false, ...mapped, receipt };
}

// ── Production wiring ────────────────────────────────────────────────────────

/**
 * The team's own decision route (`resolveDecisionRoute`, the one chat and
 * decisions use), with buildd's platform key switched off: a plan's included
 * decision calls are for buildd's own decisions, not an agent's spend. A gateway
 * route gets the public-address fetcher, as every other gateway call does.
 * Imported lazily: the DB client is server-only.
 */
export const resolveTeamDecisionRoute: RouteResolver = async ({ teamId, workspaceId, accountId }) => {
  const [{ db }, { resolveDecisionRoute }, { readDecisionModel }, { effectiveKeyPolicy }, { createPublicGatewayFetcher }] = await Promise.all([
    import('@buildd/core/db'),
    import('@buildd/core/decision-client'),
    import('@buildd/core/decision-model'),
    import('@buildd/core/inference-key-policy'),
    import('@buildd/core/net/fetch-public-gateway'),
  ]);
  const team = await db.query.teams.findFirst({
    where: (t, { eq }) => eq(t.id, teamId),
    columns: { decisionModel: true, inferenceKeyPolicy: true, credentialPolicy: true },
  });
  if (!team) return null;
  const config = readDecisionModel(team.decisionModel);
  const route = await resolveDecisionRoute(config, {
    teamId, workspaceId, accountId,
    ...(effectiveKeyPolicy(team) ? { keyPolicy: effectiveKeyPolicy(team)! } : {}),
    allowPlatformKey: false,
  });
  if (!route.apiKey) return null;
  // Jev through Cloudflare's gateway still spends the OpenRouter key; only Clef pays Cloudflare.
  const provider: ModelInferenceProvider = config?.via === 'litellm' ? 'litellm'
    : route.endpoint?.kind === 'workers-ai' ? 'cloudflare' : 'openrouter';
  return {
    apiKey: route.apiKey,
    provider,
    model: route.model || JEV_MODEL,
    ...(route.endpoint ? { endpoint: route.endpoint } : {}),
    ...(provider === 'litellm' ? { fetch: createPublicGatewayFetcher() as typeof fetch } : {}),
  };
};

export function defaultModelInferenceDeps(audit: ModelInferenceDeps['audit']): ModelInferenceDeps {
  return {
    grants: NO_GRANT_SERVICE,
    ledger: NO_LEDGER,
    resolveRoute: resolveTeamDecisionRoute,
    decide,
    audit,
  };
}

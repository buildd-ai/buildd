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
 *   minutes. The SDK's own retry is switched off (`maxRetries: 0`): its budget
 *   is per attempt with no total ceiling, and two retry loops would stack.
 * - **Gated before spend.** The team's inference policy (`inference-policy.ts`:
 *   built-ins always, chat unless switched off) is checked before the key is
 *   even resolved, exactly as `inferenceCall` does. No key ⇒ nothing runs.
 *
 * ## Credential
 *
 * An OpenRouter key in the `secrets` table (never a new table — see
 * `docs/credentials-architecture.md`) with purpose `decision_key`. An existing
 * `inference_key` row labelled `openrouter` is accepted as a fallback so a team
 * does not paste the same key twice. Resolution goes through the shared
 * `resolveInferenceKey` (`inference-keys.ts`): user → account → workspace →
 * team-wide, and `OPENROUTER_API_KEY` **outside production only**, for local
 * development and the offline eval script.
 *
 * ### buildd's platform key (billing)
 *
 * When a team has no key of its own and, with `BILLING_ENFORCED` on, its plan
 * includes decision calls (`entitlements(team).decisionCallsIncluded`), the
 * call runs on buildd's own OpenRouter key, `BUILDD_PLATFORM_DECISION_KEY`,
 * with the platform's decision model (Jev, or `BUILDD_PLATFORM_DECISION_MODEL`,
 * an open-weight chat model on OpenRouter), never the team's custom one. A
 * team's own key always wins. Billing off, a free plan, a failed plan lookup
 * or no platform key ⇒ today's behaviour: no key, no call. Chat (the
 * `interactive` capability) is never routed here, and neither is agent work,
 * which never goes through this module.
 *
 * ## Transport
 *
 * `decide` from `@builddai/ai-kit/decide`: the official TypeSafe SDK
 * (`@typesafe-ai/sdk`, MIT, pinned) pointed at OpenRouter's System One API
 * (`baseURL` `https://openrouter.ai/api`; the SDK appends `/v1/systemone`),
 * with validation, the deadline, retries and error mapping. Every SDK setting
 * is passed explicitly, because the SDK otherwise falls back to `TYPESAFE_*`
 * env vars and a stray `TYPESAFE_BASE_URL` would send a team's key somewhere
 * else. Gating and key resolution stay here.
 *
 * ## Module loading
 *
 * The DB client (and `./inference-keys`, which pulls it in) is imported lazily, on the
 * key-resolution path only. The DB client imports `server-only`, which throws
 * outside Next, so a static import would make this module unusable from a plain
 * bun script — the offline benchmark, and any caller passing its own `apiKey`.
 */

import { teams } from './db/schema';
import { eq } from 'drizzle-orm';
import {
  decide,
  describeDecideError,
  DECIDE_BASE_URL,
  DECIDE_URL,
  JEV_MODEL,
  validateDecisionRequest,
  type DecideError,
  type DecisionAnswers,
  type DecisionQuestions,
  type DecisionUsage,
  type DecisionEndpoint,
  type UsageSink,
} from '@builddai/ai-kit/decide';
import { INFERENCE_CAPABILITIES, isInferenceAllowed, type InferenceCapability } from './inference-policy';
import { effectiveKeyPolicy, type InferenceKeyPolicy } from './inference-key-policy';
import { isClefModel, normalizeDecisionModel, readDecisionModel, OPENROUTER_CHAT_BASE_URL, type DecisionModelConfig } from './decision-model';
import { entitlements, isBillingEnforced, type EntitlementTeam } from './entitlements';
import { loadTeamEntitlements } from './billing-limits';

// The question/answer types, request and response validation, `gateChoice` and
// the transport live in `@builddai/ai-kit/decide` (knowledge-base: buildd/design/shared-ai-kit.md
// P2). This module keeps buildd's policy check and key resolution, and pins the
// transport to its original retry rule, so its behaviour is unchanged.
export {
  estimateDecisionTokens,
  validateDecisionRequest,
  parseDecisionAnswers,
  gateChoice,
  MAX_DECISION_TOKENS,
  MAX_CHOICE_OPTIONS,
  MIN_SCORE_LEVELS,
  MAX_SCORE_LEVELS,
} from '@builddai/ai-kit/decide';
export type {
  DecisionText,
  ChoiceQuestion,
  ScoreQuestion,
  NoulQuestion,
  DecisionQuestion,
  DecisionQuestions,
  ChoiceAnswer,
  ScoreAnswer,
  NoulAnswer,
  AnswerFor,
  DecisionAnswers,
  DecisionUsage,
  GateOutcome,
  DecisionReceipt,
  UsageSink,
} from '@builddai/ai-kit/decide';

/** OpenRouter's System One API root, per OpenRouter's TypeSafe SDK guide. */
export const DECISIONS_BASE_URL = DECIDE_BASE_URL;

/** Where the SDK sends a decision (`baseURL` + `/v1/systemone`). */
export const DECISIONS_URL = DECIDE_URL;

/** Sent on every call so OpenRouter attributes usage to buildd. */
const ATTRIBUTION_HEADERS = { 'http-referer': 'https://buildd.dev', 'x-title': 'buildd' } as const;

/**
 * Pinned, not the `~typesafe/jev-latest` alias: confidence thresholds are tuned
 * against one version, and an alias can move under them. The pin is the kit's
 * `JEV_MODEL`; bump it there, after re-running the offline eval.
 */
export const DEFAULT_DECISION_MODEL = JEV_MODEL;

/** Secret purpose holding an OpenRouter key for decision calls. */
export const DECISION_KEY_PURPOSE = 'decision_key' as const;

/** Whole-call ceiling across all attempts. */
export const DEFAULT_DECISION_TIMEOUT_MS = 5_000;

export type DecisionError =
  | { kind: 'capability_disabled'; capability: InferenceCapability }
  | DecideError;

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
  if (error.kind === 'capability_disabled') {
    return `decision calls are not enabled for '${error.capability}' on this team`;
  }
  return describeDecideError(error);
}

// ── Key resolution ───────────────────────────────────────────────────────────

/** Env var holding buildd's own OpenRouter key for plans that include decision calls. */
export const PLATFORM_DECISION_KEY_ENV = 'BUILDD_PLATFORM_DECISION_KEY' as const;
/** Optional open-weight chat model (OpenRouter id) the platform key runs; unset ⇒ Jev. */
export const PLATFORM_DECISION_MODEL_ENV = 'BUILDD_PLATFORM_DECISION_MODEL' as const;

export interface DecisionKeyScope {
  teamId: string;
  workspaceId?: string | null;
  accountId?: string | null;
  userId?: string | null;
  /** The team's key policy, when the caller already read it (else the resolver reads it). */
  keyPolicy?: InferenceKeyPolicy;
  /** False for calls that must never run on buildd's key (chat). Default true. */
  allowPlatformKey?: boolean;
  /** The team's plan columns, when the caller already read them (else read on demand). */
  billing?: EntitlementTeam;
}

export interface ResolvedDecisionKey {
  key: string;
  /** `team`: a key the team (or its people) set. `platform`: buildd's, under the plan. */
  source: 'team' | 'platform';
}

/** The team's own OpenRouter key, through the shared resolver. */
async function resolveOwnDecisionKey(opts: DecisionKeyScope): Promise<string | null> {
  const { resolveInferenceKey } = await import('./inference-keys');
  return resolveInferenceKey({
    provider: 'openrouter',
    teamId: opts.teamId,
    workspaceId: opts.workspaceId,
    accountId: opts.accountId,
    userId: opts.userId,
    purposes: [DECISION_KEY_PURPOSE, 'inference_key'],
    ...(opts.keyPolicy ? { keyPolicy: opts.keyPolicy } : {}),
  });
}

/**
 * buildd's platform key, when this team's plan includes decision calls. Null
 * while billing is off (no read), without a configured key, or when the plan
 * can't be read: a lookup failure must never start spending buildd's money.
 */
async function platformDecisionKey(opts: DecisionKeyScope): Promise<string | null> {
  if (opts.allowPlatformKey === false || !isBillingEnforced()) return null;
  const key = process.env[PLATFORM_DECISION_KEY_ENV]?.trim();
  if (!key) return null;
  const ent = opts.billing ? entitlements(opts.billing) : await loadTeamEntitlements(opts.teamId);
  return ent.enforced && ent.decisionCallsIncluded ? key : null;
}

/** The platform key's route: Jev, or the configured open-weight chat model. */
function platformDecisionRoute(apiKey: string): { apiKey: string; endpoint?: DecisionEndpoint; model: string } {
  const configured = process.env[PLATFORM_DECISION_MODEL_ENV]?.trim();
  if (configured) {
    const r = normalizeDecisionModel({ endpoint: 'chat', via: 'openrouter', model: configured });
    if (r.ok && r.value) {
      return { apiKey, endpoint: { kind: 'chat', baseURL: OPENROUTER_CHAT_BASE_URL, provider: 'openrouter' }, model: r.value.model };
    }
    console.warn(`[decision] ignoring malformed ${PLATFORM_DECISION_MODEL_ENV}`);
  }
  return { apiKey, model: DEFAULT_DECISION_MODEL };
}

/**
 * The OpenRouter key a decision call spends, and whose it is. The team's own
 * key first, through the one shared resolver (`inference-keys.ts`), so the
 * same key serves chat, inference calls and decisions: an `inference_key`
 * labelled `openrouter`, or the legacy `decision_key`, which is still
 * preferred at the same scope so a team that set one keeps spending it.
 * Precedence is the shared one: the acting user's key, then the account's,
 * then the workspace's, then the team's, then `OPENROUTER_API_KEY` outside
 * production. Only with none of those: buildd's platform key, under the plan.
 */
export async function resolveDecisionCredential(opts: DecisionKeyScope): Promise<ResolvedDecisionKey | null> {
  const own = await resolveOwnDecisionKey(opts);
  if (own) return { key: own, source: 'team' };
  const platform = await platformDecisionKey(opts);
  return platform ? { key: platform, source: 'platform' } : null;
}

/** The key alone. See `resolveDecisionCredential`. */
export async function resolveDecisionKey(opts: DecisionKeyScope): Promise<string | null> {
  return (await resolveDecisionCredential(opts))?.key ?? null;
}

/** The team columns a decision call reads. A caller that already loaded them can pass them in. */
export interface TeamDecisionRow {
  inferenceFeatureModes: unknown;
  /** `teams.enabledDecisionShadows`, read by opt_in capabilities; absent ⇒ none enabled. */
  enabledDecisionShadows?: unknown;
  decisionModel: unknown;
  /** The key policy the key resolver enforces; absent ⇒ it reads it. */
  inferenceKeyPolicy?: unknown;
  /** `teams.credentialPolicy`; when known it wins over inferenceKeyPolicy. */
  credentialPolicy?: unknown;
  /** Plan columns, for the platform-key check; absent ⇒ that check reads them itself. */
  plan?: string | null;
  paidSeats?: number | null;
}

/**
 * The team row the call needs: may it spend on this capability, and which
 * decision model answers. Fails closed: a failed lookup means "not enabled",
 * never "spend anyway". `row` skips the read (undefined ⇒ read it; null ⇒ no team).
 */
async function loadTeamDecisionSettings(teamId: string, capability: InferenceCapability, row?: TeamDecisionRow | null): Promise<{ allowed: boolean; model: DecisionModelConfig | null; keyPolicy?: InferenceKeyPolicy; billing?: EntitlementTeam }> {
  try {
    let team = row;
    if (team === undefined) {
      const { db } = await import('./db');
      team = await db.query.teams.findFirst({
        where: eq(teams.id, teamId),
        columns: { inferenceFeatureModes: true, enabledDecisionShadows: true, decisionModel: true, inferenceKeyPolicy: true, credentialPolicy: true, plan: true, paidSeats: true },
      }) ?? null;
    }
    return {
      allowed: isInferenceAllowed(capability, team ? { featureModes: team.inferenceFeatureModes, enabledDecisionShadows: team.enabledDecisionShadows } : null),
      model: readDecisionModel(team?.decisionModel),
      ...(effectiveKeyPolicy(team) ? { keyPolicy: effectiveKeyPolicy(team)! } : {}),
      // Only a row that carries the plan column answers for it; a caller's
      // partial row leaves the platform-key check to read the plan itself.
      ...(team && 'plan' in team ? { billing: { plan: team.plan ?? null, paidSeats: team.paidSeats ?? null } } : {}),
    };
  } catch (e) {
    console.warn(`[decision] capability lookup failed for team ${teamId}:`, e);
    return { allowed: false, model: null };
  }
}

/** What a team call spends and where: the policy check and key lookup, done. */
export type DecisionAccess =
  | { ok: true; apiKey: string; endpoint?: DecisionEndpoint; model: string }
  | { ok: false; error: Extract<DecisionError, { kind: 'capability_disabled' | 'missing_key' }> };

/**
 * The policy check and key resolution a team `decisionCall` does before its
 * request, on their own. Spends nothing, so a caller can run it alongside other
 * work (the chat turn runs it alongside its limits check) and hand the result
 * to `decisionCall({ access })`, leaving the call's whole deadline to the
 * provider. Never throws; fails closed.
 */
export async function resolveDecisionAccess(opts: {
  capability: InferenceCapability;
  teamId: string;
  workspaceId?: string | null;
  accountId?: string | null;
  userId?: string | null;
  /** The team's decision columns, when the caller already has them. */
  team?: TeamDecisionRow | null;
}): Promise<DecisionAccess> {
  const settings = await loadTeamDecisionSettings(opts.teamId, opts.capability, opts.team);
  if (!settings.allowed) return { ok: false, error: { kind: 'capability_disabled', capability: opts.capability } };
  let route: Awaited<ReturnType<typeof resolveDecisionRoute>>;
  try {
    route = await resolveDecisionRoute(settings.model, {
      teamId: opts.teamId, workspaceId: opts.workspaceId, accountId: opts.accountId, userId: opts.userId,
      ...(settings.keyPolicy ? { keyPolicy: settings.keyPolicy } : {}),
      ...(settings.billing ? { billing: settings.billing } : {}),
      // Chat (interactive) never runs on buildd's key; decisions may.
      allowPlatformKey: INFERENCE_CAPABILITIES[opts.capability]?.kind !== 'interactive',
    });
  } catch (e) {
    console.warn(`[decision] key lookup failed for team ${opts.teamId}:`, e);
    return { ok: false, error: { kind: 'missing_key' } };
  }
  if (!route.apiKey) return { ok: false, error: { kind: 'missing_key' } };
  return { ok: true, apiKey: route.apiKey, ...(route.endpoint ? { endpoint: route.endpoint } : {}), model: route.model };
}

/**
 * Key, endpoint and model for a team's decision model. Null key ⇒ nothing to
 * spend: no OpenRouter key, or (via the gateway) no gateway, and no platform
 * key under the plan either. The platform key always runs the platform's
 * model, never the team's custom one.
 */
export async function resolveDecisionRoute(
  config: DecisionModelConfig | null,
  scope: DecisionKeyScope,
): Promise<{ apiKey: string | null; endpoint?: DecisionEndpoint; model: string }> {
  if (config?.via === 'cloudflare') return resolveCloudflareDecisionRoute(config, scope);
  if (config?.via === 'litellm') {
    const { resolveLiteLLMGateway } = await import('./litellm-gateway');
    const gateway = await resolveLiteLLMGateway({ teamId: scope.teamId, workspaceId: scope.workspaceId });
    if (gateway) {
      return { apiKey: gateway.apiKey, endpoint: { kind: 'chat', baseURL: gateway.baseURL, provider: 'openai' }, model: config.model };
    }
    const platform = await platformDecisionKey(scope);
    return platform ? platformDecisionRoute(platform) : { apiKey: null, model: config.model };
  }
  const credential = await resolveDecisionCredential(scope);
  if (credential?.source === 'platform') return platformDecisionRoute(credential.key);
  if (!config) return { apiKey: credential?.key ?? null, model: DEFAULT_DECISION_MODEL };
  return {
    apiKey: credential?.key ?? null,
    endpoint: config.endpoint === 'chat' ? { kind: 'chat', baseURL: OPENROUTER_CHAT_BASE_URL, provider: 'openrouter' } : undefined,
    model: config.model,
  };
}

/**
 * `via: 'cloudflare'`: the team's Cloudflare credential (`cloudflare-ai-gateway.ts`).
 * Clef spends the Cloudflare token on Workers AI (through the gateway when
 * there is one). Jev goes through the gateway's OpenRouter path on the team's
 * own OpenRouter key; buildd's platform key never goes through a team's
 * gateway, so it runs the platform route as before. No credential (or, for
 * Jev, no gateway) ⇒ no key: a team that chose Cloudflare is not silently
 * moved elsewhere.
 */
async function resolveCloudflareDecisionRoute(
  config: DecisionModelConfig,
  scope: DecisionKeyScope,
): Promise<{ apiKey: string | null; endpoint?: DecisionEndpoint; model: string }> {
  const { resolveCloudflareAiGateway, clefBaseURL, jevGatewayBaseURL, gatewayAuthHeaders } = await import('./cloudflare-ai-gateway');
  const cf = await resolveCloudflareAiGateway({ teamId: scope.teamId });
  if (isClefModel(config.model)) {
    if (!cf) return { apiKey: null, model: config.model };
    return {
      apiKey: cf.apiToken,
      endpoint: { kind: 'workers-ai', baseURL: clefBaseURL(cf), ...(cf.gatewayId ? { headers: gatewayAuthHeaders(cf) } : {}) },
      model: config.model,
    };
  }
  const credential = await resolveDecisionCredential(scope);
  if (credential?.source === 'platform') return platformDecisionRoute(credential.key);
  const baseURL = cf ? jevGatewayBaseURL(cf) : null;
  if (!cf || !baseURL || !credential) return { apiKey: null, model: config.model };
  return { apiKey: credential.key, endpoint: { kind: 'systemone', baseURL, headers: gatewayAuthHeaders(cf) }, model: config.model };
}

// ── Transport ────────────────────────────────────────────────────────────────

type Fetcher = typeof fetch;

/**
 * buildd's original retry rule: 429 and 5xx. The kit's default also retries
 * 408; buildd keeps its rule so this migration changes no behaviour.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface DecisionCallParams<Q extends DecisionQuestions> {
  /** Which call site — checked against the team's inference policy before any spend. */
  capability: InferenceCapability;
  teamId: string;
  workspaceId?: string | null;
  /** The acting user's account, for account-scoped keys. */
  accountId?: string | null;
  /** The signed-in person the call is for, so their own OpenRouter key is spent first. */
  userId?: string | null;
  /** Keep it small: accuracy falls as irrelevant state grows. */
  state: string | Record<string, unknown> | unknown[];
  questions: Q;
  model?: string;
  /** Whole-call deadline across all attempts (default 5s). */
  timeoutMs?: number;
  /** Pre-resolved key (the offline eval passes one; skips DB lookup + policy). */
  apiKey?: string;
  /** With `apiKey` only: where to send it (default Jev on OpenRouter). A team call uses the team's decision model. */
  endpoint?: DecisionEndpoint;
  /**
   * Receipt sink (the kit's): called once per call that reached the provider,
   * timeouts and errors included; never for a gated or keyless call.
   */
  onUsage?: UsageSink;
  /** Stamped on the receipt, e.g. the `ai_usage` kind. */
  decisionId?: string;
  /**
   * The team's policy check and key, already resolved (`resolveDecisionAccess`),
   * so the deadline covers only the request. A refusal is returned as the result.
   */
  access?: DecisionAccess | Promise<DecisionAccess>;
  /** Test seams. */
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Make one decision call. See the module docstring for the contract.
 *
 * When `apiKey` is supplied the policy and key lookup are skipped — that path
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
  let endpoint = params.apiKey ? params.endpoint : undefined;
  let model = params.model ?? DEFAULT_DECISION_MODEL;
  if (!apiKey) {
    const access = params.access
      ? await params.access
      : await resolveDecisionAccess({
        capability: params.capability, teamId: params.teamId, workspaceId: params.workspaceId,
        accountId: params.accountId, userId: params.userId,
      });
    if (!access.ok) return fail(access.error, 0);
    apiKey = access.apiKey;
    endpoint = access.endpoint;
    // An explicit model is the caller's; otherwise the team's decision model.
    model = params.model ?? access.model;
  }

  // The kit's transport: SDK retry off, every SDK option explicit, one retry
  // inside the deadline. `startedAt` keeps the policy check and key lookup
  // inside the same deadline and latency, as before; with `access` passed in,
  // they happened before this call and the deadline is the provider's alone.
  return decide<Q>({
    apiKey,
    state: params.state,
    questions: params.questions,
    model,
    ...(endpoint ? { endpoint } : {}),
    timeoutMs,
    startedAt: started,
    maxAttempts: 2,
    retryable: isRetryableStatus,
    retryBackoffMs: 250,
    minRetryBudgetMs: 500,
    headers: { ...ATTRIBUTION_HEADERS },
    ...(params.onUsage ? { onUsage: params.onUsage } : {}),
    ...(params.decisionId ? { decisionId: params.decisionId } : {}),
    fetch: fetcher,
    sleep,
    now,
  });
}

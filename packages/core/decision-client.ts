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
import { isInferenceAllowed, type InferenceCapability } from './inference-policy';
import { readDecisionModel, OPENROUTER_CHAT_BASE_URL, type DecisionModelConfig } from './decision-model';

// The question/answer types, request and response validation, `gateChoice` and
// the transport live in `@builddai/ai-kit/decide` (docs/design/shared-ai-kit.md
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

/**
 * The OpenRouter key a decision call spends. Resolved through the one shared
 * resolver (`inference-keys.ts`), so the same key serves chat, inference calls
 * and decisions: an `inference_key` labelled `openrouter`, or the legacy
 * `decision_key`, which is still preferred at the same scope so a team that
 * set one keeps spending it. Precedence is the shared one: the acting user's
 * key, then the account's, then the workspace's, then the team's, then
 * `OPENROUTER_API_KEY` outside production.
 */
export async function resolveDecisionKey(opts: {
  teamId: string;
  workspaceId?: string | null;
  accountId?: string | null;
  userId?: string | null;
}): Promise<string | null> {
  const { resolveInferenceKey } = await import('./inference-keys');
  return resolveInferenceKey({
    provider: 'openrouter',
    teamId: opts.teamId,
    workspaceId: opts.workspaceId,
    accountId: opts.accountId,
    userId: opts.userId,
    purposes: [DECISION_KEY_PURPOSE, 'inference_key'],
  });
}

/**
 * The team row the call needs: may it spend on this capability, and which
 * decision model answers. Fails closed: a failed lookup means "not enabled",
 * never "spend anyway".
 */
async function loadTeamDecisionSettings(teamId: string, capability: InferenceCapability): Promise<{ allowed: boolean; model: DecisionModelConfig | null }> {
  try {
    const { db } = await import('./db');
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { inferenceFeatureModes: true, decisionModel: true },
    });
    return {
      allowed: isInferenceAllowed(capability, team ? { featureModes: team.inferenceFeatureModes } : null),
      model: readDecisionModel(team?.decisionModel),
    };
  } catch (e) {
    console.warn(`[decision] capability lookup failed for team ${teamId}:`, e);
    return { allowed: false, model: null };
  }
}

/**
 * Key, endpoint and model for a team's decision model. Null key ⇒ nothing to
 * spend: no OpenRouter key, or (via the gateway) no gateway.
 */
export async function resolveDecisionRoute(
  config: DecisionModelConfig | null,
  scope: { teamId: string; workspaceId?: string | null; accountId?: string | null; userId?: string | null },
): Promise<{ apiKey: string | null; endpoint?: DecisionEndpoint; model: string }> {
  if (!config) return { apiKey: await resolveDecisionKey(scope), model: DEFAULT_DECISION_MODEL };
  if (config.via === 'litellm') {
    const { resolveLiteLLMGateway } = await import('./litellm-gateway');
    const gateway = await resolveLiteLLMGateway({ teamId: scope.teamId, workspaceId: scope.workspaceId });
    return {
      apiKey: gateway?.apiKey ?? null,
      endpoint: gateway ? { kind: 'chat', baseURL: gateway.baseURL, provider: 'openai' } : undefined,
      model: config.model,
    };
  }
  return {
    apiKey: await resolveDecisionKey(scope),
    endpoint: config.endpoint === 'chat' ? { kind: 'chat', baseURL: OPENROUTER_CHAT_BASE_URL, provider: 'openrouter' } : undefined,
    model: config.model,
  };
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
    const settings = await loadTeamDecisionSettings(params.teamId, params.capability);
    if (!settings.allowed) {
      return fail({ kind: 'capability_disabled', capability: params.capability }, 0);
    }
    const route = await resolveDecisionRoute(settings.model, {
      teamId: params.teamId, workspaceId: params.workspaceId, accountId: params.accountId,
      userId: params.userId,
    });
    apiKey = route.apiKey;
    endpoint = route.endpoint;
    // An explicit model is the caller's; otherwise the team's decision model.
    model = params.model ?? route.model;
    if (!apiKey) return fail({ kind: 'missing_key' }, 0);
  }

  // The kit's transport: SDK retry off, every SDK option explicit, one retry
  // inside the deadline. `startedAt` keeps the policy check and key lookup
  // inside the same deadline and latency, as before.
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

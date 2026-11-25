/**
 * Which model serves a chat turn: a tier, never a user-picked model.
 *
 * The tier → (provider, model) mapping is the team admin's, through the tier
 * registry (`resolveTierEntry`). The route comes from the one resolver
 * (`resolveInferenceRoute`): the tier vendor's own key, then OpenRouter, then
 * the team's LiteLLM gateway, each key from the user's own, then the
 * workspace's, then the team's. Chat never falls back to a subscription seat.
 */

import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { resolveTierEntry } from '@buildd/core/model-tier-registry';
import { drawChatPoolArm, type ChatPoolDraw } from '@buildd/core/tier-pool-source';
import { resolveInferenceCredential, isInferenceKeyProvider, type InferenceKeyScope } from '@buildd/core/inference-keys';
import { isRouteVendor, resolveInferenceRoute } from '@buildd/core/inference-route';
import { priceForModel } from '@buildd/core/model-prices';
import type { Tier } from '@buildd/core/model-tier-defaults';
import type { ChatProvider } from '@buildd/shared';
import { openRouterModelId } from './openrouter-id';
import { resolveLiteLLMGateway, type LiteLLMGateway } from '@buildd/core/litellm-gateway';
import { gatewayModel } from '@buildd/ai-kit/models';
import { createPublicGatewayFetcher } from '@buildd/core/net/fetch-public-gateway';
import { loadLocalRunnerPick, relayAvailability, type LocalRunnerPick } from '@buildd/core/model-relay';
import type { RelayErrorCode } from '@buildd/shared';
import { localRunnerLanguageModel } from './local-runner-model';

export type ChatTier = Extract<Tier, 'budget' | 'standard' | 'premium'>;

export type ResolvedChatModel =
  | {
    ok: true; model: LanguageModel; provider: ChatProvider | 'local_runner'; modelId: string; tier: ChatTier; keyScope: InferenceKeyScope;
    /**
     * `litellm`: the team's LiteLLM gateway serves the turn; `modelId` stays the planned model, for pricing.
     * `local_runner`: the team's own runner serves it through the relay; `modelId` is its model tag and the turn costs nothing.
     */
    via?: 'litellm' | 'local_runner';
    /** Set when the tier's chat pool enrolled this turn (knowledge-base: buildd/design/tier-model-pools.md). */
    pool?: ChatPoolDraw;
  }
  | { ok: false; reason: 'no_key' | 'unsupported_provider'; provider: string; tier: ChatTier }
  /**
   * Chat is assigned to the team's own runner and it cannot serve the turn.
   * Final: the caller refuses the turn and tries no other tier, key or provider.
   */
  | { ok: false; reason: 'local_runner_unavailable'; provider: 'local_runner'; tier: ChatTier; runnerId: string | null; code: RelayErrorCode; detail: string };

export function languageModelFor(provider: ChatProvider, modelId: string, apiKey: string): LanguageModel {
  switch (provider) {
    case 'anthropic': return createAnthropic({ apiKey })(modelId);
    case 'openai': return createOpenAI({ apiKey }).chat(modelId);
    case 'openrouter':
      return createOpenRouter({ apiKey, appName: 'buildd', appUrl: 'https://buildd.dev' })
        .chat(modelId, { usage: { include: true } });
  }
}

export { openRouterModelId };

// One per process: it caches each gateway host's public-address check briefly.
const gatewayFetch = createPublicGatewayFetcher();

/** The planned model through a LiteLLM gateway, on its OpenAI-compatible API.
 * Calls only reach public addresses and never follow redirects. */
export function gatewayLanguageModel(
  gateway: LiteLLMGateway,
  provider: ChatProvider,
  modelId: string,
  fetchImpl: typeof fetch = gatewayFetch as typeof fetch,
): LanguageModel {
  return createOpenAI({ apiKey: gateway.apiKey, baseURL: gateway.baseURL, fetch: fetchImpl })
    .chat(gatewayModel({ kind: 'litellm', baseURL: gateway.baseURL }, provider, modelId));
}

interface ResolveDeps {
  resolveTierEntry: typeof resolveTierEntry;
  resolveInferenceCredential: typeof resolveInferenceCredential;
  drawChatPoolArm?: typeof drawChatPoolArm;
  resolveLiteLLMGateway?: typeof resolveLiteLLMGateway;
  /** The team's `local_runner` pick. Absent (a caller with its own deps): chat is never on the relay. */
  loadLocalRunnerPick?: (teamId: string) => Promise<LocalRunnerPick | null>;
  now?: () => number;
}

/**
 * What a chat turn passes so its tier's pool can enrol it. Callers that are
 * not a user's turn (auto-title, availability probes) pass nothing and always
 * get the incumbent.
 */
export interface ChatPoolContext {
  conversationId: string;
  /** Stable per chain start, e.g. `${conversationId}#${storedMessageCount}`. */
  drawKey: string;
  /** The last stored assistant turn, for chain stickiness. */
  previous: { id: string; tier: string | null; createdAt: Date } | null;
  now: Date;
}

export async function resolveChatModel(
  opts: {
    tier: ChatTier;
    teamId: string;
    workspaceId: string | null;
    userId: string;
    pool?: ChatPoolContext;
  },
  deps: ResolveDeps = { resolveTierEntry, resolveInferenceCredential, drawChatPoolArm, resolveLiteLLMGateway, loadLocalRunnerPick },
): Promise<ResolvedChatModel> {
  const local = await resolveLocalRunnerChat(opts, deps);
  if (local) return local;
  const incumbent = await resolveIncumbentChatModel(opts, deps);
  if (!incumbent.ok || !opts.pool || !deps.drawChatPoolArm) return incumbent;
  return withChatPool(incumbent, opts, opts.pool, deps);
}

/**
 * Chat assigned to `local_runner` (docs/specs/local-runner-provider.md §7.2).
 * The assignment is exclusive: the turn is served by the pinned runner's chat
 * model through the relay or refused. The tier, the tier pool, every stored
 * key and the gateway are skipped, so a team that chose its own runner is
 * never billed by a provider it did not choose. Null: chat is not assigned to
 * the local runner (or the assignment could not be read) and the usual
 * resolution applies.
 */
async function resolveLocalRunnerChat(
  opts: { tier: ChatTier; teamId: string; workspaceId: string | null },
  deps: ResolveDeps,
): Promise<ResolvedChatModel | null> {
  if (!deps.loadLocalRunnerPick) return null;
  let pick: LocalRunnerPick | null;
  try {
    pick = await deps.loadLocalRunnerPick(opts.teamId);
  } catch (err) {
    console.warn('[chat] local runner pick lookup failed:', err instanceof Error ? err.message : err);
    return null;
  }
  if (!pick?.chatAssigned) return null;
  const refused = (code: RelayErrorCode, detail: string): ResolvedChatModel => (
    { ok: false, reason: 'local_runner_unavailable', provider: 'local_runner', tier: opts.tier, runnerId: pick.runnerId, code, detail }
  );
  if (!pick.chatModel) return refused('model_missing', 'No chat model is chosen for the local runner.');
  const available = relayAvailability(pick, pick.chatModel, 'completion', (deps.now ?? Date.now)());
  if (!available.ok) return refused(available.code, available.message);
  return {
    ok: true,
    model: localRunnerLanguageModel({ teamId: opts.teamId, workspaceId: opts.workspaceId, modelId: pick.chatModel }),
    provider: 'local_runner',
    modelId: pick.chatModel,
    tier: opts.tier,
    keyScope: 'team',
    via: 'local_runner',
  };
}

/**
 * The pool step. The incumbent is served on its own route, with the
 * OpenRouter fallback as today; a challenger is served on its exact route, and
 * when this user has no key for that route the turn serves the incumbent and
 * records `served = false`. Never throws.
 */
async function withChatPool(
  incumbent: ResolvedChatModel & { ok: true },
  opts: { tier: ChatTier; teamId: string; workspaceId: string | null; userId: string },
  pool: ChatPoolContext,
  deps: ResolveDeps,
): Promise<ResolvedChatModel> {
  try {
    const entry = await deps.resolveTierEntry(opts.tier, opts.teamId, opts.workspaceId, 'chat');
    const draw = await deps.drawChatPoolArm!({
      teamId: opts.teamId, workspaceId: opts.workspaceId, tier: opts.tier,
      conversationId: pool.conversationId, drawKey: pool.drawKey, previous: pool.previous,
      workspaceOverride: entry.source === 'workspace', now: pool.now,
    });
    if (!draw) return incumbent;
    draw.defaultModel = incumbent.modelId;
    draw.assignedModel = incumbent.modelId;
    if (draw.arm.role === 'incumbent') {
      draw.served = true;
      return { ...incumbent, pool: draw };
    }
    const route = draw.arm.route;
    draw.served = false;
    if (!isInferenceKeyProvider(route)) return { ...incumbent, pool: draw };
    const cred = await deps.resolveInferenceCredential({ provider: route, teamId: opts.teamId, workspaceId: opts.workspaceId, userId: opts.userId });
    if (!cred) return { ...incumbent, pool: draw };
    draw.served = true;
    draw.assignedModel = draw.arm.model;
    return {
      ok: true,
      model: languageModelFor(route, draw.arm.model, cred.key),
      provider: route,
      modelId: draw.arm.model,
      tier: opts.tier,
      keyScope: cred.scope,
      pool: draw,
    };
  } catch (err) {
    console.warn('[chat] tier pool step failed; serving the incumbent:', err);
    return incumbent;
  }
}

async function resolveIncumbentChatModel(
  opts: { tier: ChatTier; teamId: string; workspaceId: string | null; userId: string },
  deps: ResolveDeps,
): Promise<ResolvedChatModel> {
  const entry = await deps.resolveTierEntry(opts.tier, opts.teamId, opts.workspaceId, 'chat');
  const provider = entry.provider as string;
  if (!isRouteVendor(provider)) return { ok: false, reason: 'unsupported_provider', provider, tier: opts.tier };
  // The vendor's own key, then OpenRouter (which serves the same Anthropic and
  // OpenAI models), then the team's LiteLLM gateway: one order for chat and
  // inference calls (@buildd/core/inference-route).
  const route = await resolveInferenceRoute(
    { vendor: provider, model: entry.model, teamId: opts.teamId, workspaceId: opts.workspaceId, userId: opts.userId },
    {
      resolveInferenceCredential: deps.resolveInferenceCredential,
      resolveLiteLLMGateway: deps.resolveLiteLLMGateway ?? (async () => null),
    },
  );
  if (!route) return { ok: false, reason: 'no_key', provider, tier: opts.tier };
  if (route.route === 'litellm') {
    return {
      ok: true,
      model: gatewayLanguageModel({ apiKey: route.apiKey, baseURL: route.baseURL }, provider, entry.model),
      provider,
      modelId: entry.model,
      tier: opts.tier,
      keyScope: route.keyScope,
      via: 'litellm',
    };
  }
  return {
    ok: true,
    model: languageModelFor(route.route, route.modelId, route.apiKey),
    provider: route.route,
    modelId: route.modelId,
    tier: opts.tier,
    keyScope: route.keyScope,
  };
}

type CostUsage = { inputTokens?: number; outputTokens?: number };
type CostStep = { usage?: CostUsage; providerMetadata?: Record<string, unknown> };

function reportedCostOf(providerMetadata?: Record<string, unknown>): number | null {
  const c = (providerMetadata?.openrouter as { usage?: { cost?: unknown } } | undefined)?.usage?.cost;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

function estimatedCostOf(modelId: string, usage: CostUsage): number {
  const p = priceForModel(modelId.includes('/') ? modelId.split('/').pop()! : modelId);
  return ((usage.inputTokens ?? 0) * p.input + (usage.outputTokens ?? 0) * p.output) / 1_000_000;
}

/**
 * USD for a turn: the provider's own figure when it reports one (OpenRouter
 * does), else an estimate from the price table. Null when there's no usage.
 *
 * `providerMetadata` is the LAST step's alone, so a multi-step turn passes
 * `steps`: their reported costs are summed, and a step with none is priced from
 * its own usage. When no step reports a cost this is the whole-turn estimate.
 */
export function turnCostUsd(
  modelId: string,
  usage: CostUsage | undefined,
  providerMetadata?: Record<string, unknown>,
  steps?: ReadonlyArray<CostStep>,
): number | null {
  if (steps?.some(s => reportedCostOf(s.providerMetadata) !== null)) {
    return steps.reduce((sum, s) => sum + (reportedCostOf(s.providerMetadata) ?? estimatedCostOf(modelId, s.usage ?? {})), 0);
  }
  const reported = reportedCostOf(providerMetadata);
  if (reported !== null) return reported;
  if (!usage) return null;
  return estimatedCostOf(modelId, usage);
}

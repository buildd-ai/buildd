/**
 * Which model serves a chat turn: a tier, never a user-picked model.
 *
 * The tier → (provider, model) mapping is the team admin's, through the tier
 * registry (`resolveTierEntry`). The key comes from the one resolver
 * (`resolveInferenceCredential`): the user's own key, then the workspace's,
 * then the team's. Chat never falls back to a subscription seat.
 */

import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { resolveTierEntry } from '@buildd/core/model-tier-registry';
import { drawChatPoolArm, type ChatPoolDraw } from '@buildd/core/tier-pool-source';
import { resolveInferenceCredential, isInferenceKeyProvider, type InferenceKeyScope } from '@buildd/core/inference-keys';
import { priceForModel } from '@buildd/core/model-prices';
import type { Tier } from '@buildd/core/model-tier-defaults';
import type { ChatProvider } from '@buildd/shared';
import { openRouterModelId } from './openrouter-id';

export type ChatTier = Extract<Tier, 'budget' | 'standard' | 'premium'>;

export type ResolvedChatModel =
  | {
    ok: true; model: LanguageModel; provider: ChatProvider; modelId: string; tier: ChatTier; keyScope: InferenceKeyScope;
    /** Set when the tier's chat pool enrolled this turn (docs/design/tier-model-pools.md). */
    pool?: ChatPoolDraw;
  }
  | { ok: false; reason: 'no_key' | 'unsupported_provider'; provider: string; tier: ChatTier };

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

interface ResolveDeps {
  resolveTierEntry: typeof resolveTierEntry;
  resolveInferenceCredential: typeof resolveInferenceCredential;
  drawChatPoolArm?: typeof drawChatPoolArm;
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
  deps: ResolveDeps = { resolveTierEntry, resolveInferenceCredential, drawChatPoolArm },
): Promise<ResolvedChatModel> {
  const incumbent = await resolveIncumbentChatModel(opts, deps);
  if (!incumbent.ok || !opts.pool || !deps.drawChatPoolArm) return incumbent;
  return withChatPool(incumbent, opts, opts.pool, deps);
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
  if (!isInferenceKeyProvider(provider)) return { ok: false, reason: 'unsupported_provider', provider, tier: opts.tier };
  const scope = { teamId: opts.teamId, workspaceId: opts.workspaceId, userId: opts.userId };
  const cred = await deps.resolveInferenceCredential({ provider, ...scope });
  if (cred) {
    return {
      ok: true,
      model: languageModelFor(provider, entry.model, cred.key),
      provider,
      modelId: entry.model,
      tier: opts.tier,
      keyScope: cred.scope,
    };
  }
  // OpenRouter serves the same Anthropic and OpenAI models, so a team whose
  // only key is OpenRouter still gets the tier's model through it.
  if (provider !== 'openrouter') {
    const orCred = await deps.resolveInferenceCredential({ provider: 'openrouter', ...scope });
    if (orCred) {
      const modelId = openRouterModelId(provider, entry.model);
      return {
        ok: true,
        model: languageModelFor('openrouter', modelId, orCred.key),
        provider: 'openrouter',
        modelId,
        tier: opts.tier,
        keyScope: orCred.scope,
      };
    }
  }
  return { ok: false, reason: 'no_key', provider, tier: opts.tier };
}

/**
 * USD for a turn: the provider's own figure when it reports one (OpenRouter
 * does), else an estimate from the price table. Null when there's no usage.
 */
export function turnCostUsd(
  modelId: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  providerMetadata?: Record<string, unknown>,
): number | null {
  const reported = (providerMetadata?.openrouter as { usage?: { cost?: unknown } } | undefined)?.usage?.cost;
  if (typeof reported === 'number' && Number.isFinite(reported)) return reported;
  if (!usage) return null;
  const p = priceForModel(modelId.includes('/') ? modelId.split('/').pop()! : modelId);
  return ((usage.inputTokens ?? 0) * p.input + (usage.outputTokens ?? 0) * p.output) / 1_000_000;
}

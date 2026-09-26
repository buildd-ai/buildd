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
import { resolveInferenceCredential, isInferenceKeyProvider, type InferenceKeyScope } from '@buildd/core/inference-keys';
import { priceForModel } from '@buildd/core/model-prices';
import type { Tier } from '@buildd/core/model-tier-defaults';
import type { ChatProvider } from '@buildd/shared';

export type ChatTier = Extract<Tier, 'budget' | 'standard' | 'premium'>;

export type ResolvedChatModel =
  | { ok: true; model: LanguageModel; provider: ChatProvider; modelId: string; tier: ChatTier; keyScope: InferenceKeyScope }
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

/**
 * The OpenRouter slug for a native model id. OpenRouter writes Anthropic
 * versions with a dot and no snapshot date (`claude-haiku-4-5-20251001` ->
 * `anthropic/claude-haiku-4.5`); OpenAI ids keep their own dots.
 */
export function openRouterModelId(provider: string, modelId: string): string {
  if (provider === 'openrouter' || modelId.includes('/')) return modelId;
  if (provider === 'anthropic') {
    const undated = modelId.replace(/-\d{8}$/, '');
    return `anthropic/${undated.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
  }
  return `${provider}/${modelId}`;
}

interface ResolveDeps {
  resolveTierEntry: typeof resolveTierEntry;
  resolveInferenceCredential: typeof resolveInferenceCredential;
}

export async function resolveChatModel(
  opts: {
    tier: ChatTier;
    teamId: string;
    workspaceId: string | null;
    userId: string;
  },
  deps: ResolveDeps = { resolveTierEntry, resolveInferenceCredential },
): Promise<ResolvedChatModel> {
  const entry = await deps.resolveTierEntry(opts.tier, opts.teamId, opts.workspaceId);
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

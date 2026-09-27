/**
 * Turn a plan into what a provider SDK (or a bare `fetch`) needs to make the
 * call. Pure: no SDK imports, no env reads. The app supplies its own keys.
 *
 * ```ts
 * const cfg = toCallConfig(plan, { apiKeys: { openrouter: env.OPENROUTER_API_KEY }, appName: 'cue' });
 * const openrouter = createOpenRouter({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, headers: cfg.headers });
 * streamText({ model: openrouter(cfg.model), ... });
 * ```
 */

import type { KitProvider, PlanEffort, ResolvedPlan } from './types';

export const PROVIDER_BASE_URLS: Record<KitProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
};

export interface CallConfig {
  provider: KitProvider;
  /** The id to send to that provider, exactly as planned (OpenRouter slugs already rewritten). */
  model: string;
  baseURL: string;
  /** From `apiKeys[provider]`; undefined when not given. */
  apiKey: string | undefined;
  /** Non-auth headers (attribution, API version). Auth is the SDK's job, from `apiKey`. */
  headers: Record<string, string>;
  /** Extra request-body fields the provider needs for accurate receipts. */
  extraBody: Record<string, unknown>;
  /** The tier's default effort; map it to the provider's own reasoning option. */
  effort: PlanEffort | null;
  maxTurns: number | null;
}

export interface CallConfigOptions {
  apiKeys?: Partial<Record<KitProvider, string>>;
  /** OpenRouter `X-Title` attribution. */
  appName?: string;
  /** OpenRouter `HTTP-Referer` attribution. */
  appUrl?: string;
}

export function toCallConfig(plan: Pick<ResolvedPlan, 'provider' | 'model' | 'effort' | 'limits'>, opts: CallConfigOptions = {}): CallConfig {
  const headers: Record<string, string> = {};
  const extraBody: Record<string, unknown> = {};
  if (plan.provider === 'openrouter') {
    if (opts.appName) headers['X-Title'] = opts.appName;
    if (opts.appUrl) headers['HTTP-Referer'] = opts.appUrl;
    // Ask OpenRouter to return the call's cost, so the receipt carries `costUsd`.
    extraBody.usage = { include: true };
  } else if (plan.provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }
  return {
    provider: plan.provider,
    model: plan.model,
    baseURL: PROVIDER_BASE_URLS[plan.provider],
    apiKey: opts.apiKeys?.[plan.provider],
    headers,
    extraBody,
    effort: plan.effort ?? null,
    maxTurns: plan.limits?.maxTurns ?? null,
  };
}

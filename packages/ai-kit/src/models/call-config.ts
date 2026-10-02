/**
 * Turn a plan into what a provider SDK (or a bare `fetch`) needs to make the
 * call. Pure: no SDK imports, no env reads. The app supplies its own keys.
 *
 * ```ts
 * const cfg = toCallConfig(plan, { apiKeys: { openrouter: env.OPENROUTER_API_KEY }, appName: 'cue' });
 * const openrouter = createOpenRouter({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, headers: cfg.headers });
 * streamText({ model: openrouter(cfg.model), ... });
 * ```
 *
 * **Through a LiteLLM gateway** (0.7.0): the plan still names the real
 * provider and model, and the gateway serves it on one OpenAI-compatible API.
 * `via` is `litellm`, so build an OpenAI-compatible client, whatever
 * `provider` says:
 *
 * ```ts
 * const cfg = toCallConfig(plan, { gateway: { kind: 'litellm', baseURL: env.LITELLM_URL, apiKey: env.LITELLM_KEY } });
 * const litellm = createOpenAICompatible({ name: 'litellm', apiKey: cfg.apiKey, baseURL: cfg.baseURL });
 * streamText({ model: litellm(cfg.model), ... }); // cfg.model: 'anthropic/claude-…'
 * ```
 *
 * Receipts keep `plan.provider` and `plan.model`, so buildd prices the call as
 * the model it is. List in `createModelsClient({ providers })` the providers
 * the gateway can reach.
 */

import type { KitProvider, PlanEffort, ResolvedPlan } from './types';
import { ROUTES, routeAttributionHeaders, routeModelId, type GatewayNaming } from './routes';

/** Each vendor's own API root (`ROUTES[vendor].baseURL`). */
export const PROVIDER_BASE_URLS: Record<KitProvider, string> = {
  openrouter: ROUTES.openrouter.baseURL!,
  anthropic: ROUTES.anthropic.baseURL!,
  openai: ROUTES.openai.baseURL!,
};

/**
 * A LiteLLM proxy in front of the providers. `models` maps a plan's
 * `provider/model` (or bare `model`) to the proxy's own alias; anything
 * unmapped is sent as `provider/model`, LiteLLM's convention. `prefix: false`
 * sends the bare model id instead.
 */
export interface GatewayConfig extends GatewayNaming {
  kind: 'litellm';
  /** The proxy's OpenAI-compatible root, e.g. `https://litellm.example.com/v1`. */
  baseURL: string;
  /** The proxy's key (a LiteLLM virtual key). */
  apiKey?: string;
}

/** The model id a gateway is sent for a plan. Pure. */
export function gatewayModel(gateway: GatewayConfig | GatewayNaming, provider: KitProvider, model: string): string {
  return routeModelId('litellm', provider, model, gateway);
}

export interface CallConfig {
  /** The planned provider. With a gateway, the one behind it: pick the SDK by `via`. */
  provider: KitProvider;
  /** `direct`: call `provider` with its own SDK. `litellm`: an OpenAI-compatible client at `baseURL`. */
  via: 'direct' | 'litellm';
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
  /** Route the call through a LiteLLM proxy instead of the provider. */
  gateway?: GatewayConfig;
}

export function toCallConfig(plan: Pick<ResolvedPlan, 'provider' | 'model' | 'effort' | 'limits'>, opts: CallConfigOptions = {}): CallConfig {
  if (opts.gateway) {
    const g = opts.gateway;
    if (g.kind !== 'litellm') throw new Error(`toCallConfig: unknown gateway kind '${String((g as { kind?: unknown }).kind)}'`);
    if (!g.baseURL) throw new Error('toCallConfig: a litellm gateway needs a baseURL');
    return {
      provider: plan.provider,
      via: 'litellm',
      model: gatewayModel(g, plan.provider, plan.model),
      baseURL: g.baseURL.replace(/\/+$/, ''),
      apiKey: g.apiKey,
      headers: {},
      extraBody: {},
      effort: plan.effort ?? null,
      maxTurns: plan.limits?.maxTurns ?? null,
    };
  }
  const route = ROUTES[plan.provider];
  const headers: Record<string, string> = { ...route.headers, ...routeAttributionHeaders(plan.provider, opts) };
  const extraBody: Record<string, unknown> = {};
  // Ask OpenRouter to return the call's cost, so the receipt carries `costUsd`.
  if (route.reportsCost) extraBody.usage = { include: true };
  return {
    provider: plan.provider,
    via: 'direct',
    model: plan.model,
    baseURL: PROVIDER_BASE_URLS[plan.provider],
    apiKey: opts.apiKeys?.[plan.provider],
    headers,
    extraBody,
    effort: plan.effort ?? null,
    maxTurns: plan.limits?.maxTurns ?? null,
  };
}

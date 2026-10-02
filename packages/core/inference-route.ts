/**
 * Which route serves a server-side call to a vendor's model, and with which key.
 *
 * Chat turns and inference calls both name a vendor and a native model (from
 * the tier registry). This picks the first route in `routeOrder(vendor)`
 * (`@builddai/ai-kit/models` routes.ts) that has a credential for the caller:
 * the vendor's own API, then OpenRouter, then the team's LiteLLM gateway. One
 * order, so a team whose only key is OpenRouter (or a gateway) gets every
 * server-side feature, not just chat.
 *
 * Keys come from `resolveInferenceCredential` (inference-keys.ts), so the
 * scope precedence and the team's key policy apply unchanged; the gateway from
 * `resolveLiteLLMGateway`, which the policy binds too. Subscription seats never
 * serve here (inference-client.ts, "Why OAuth cannot back an inference call").
 *
 * ## Module loading
 *
 * The resolvers are imported lazily, so this loads in a plain bun process.
 */

import {
  ROUTES, routeModelId, routeOrder,
  type KitProvider, type RouteId, type RouteWire,
} from '@builddai/ai-kit/models';
import type { InferenceKeyScope, ResolvedInferenceCredential, ResolveInferenceKeyOptions } from './inference-keys';
import type { InferenceKeyPolicy } from './inference-key-policy';
import type { LiteLLMGateway } from './litellm-gateway';

/** Vendors a server-side call can name. `openai-codex` and other agent backends are not. */
export function isRouteVendor(value: unknown): value is KitProvider {
  return value === 'anthropic' || value === 'openai' || value === 'openrouter';
}

export interface ResolvedInferenceRoute {
  route: RouteId;
  wire: RouteWire;
  /** The planned vendor and native model id: what receipts and prices name. */
  vendor: KitProvider;
  model: string;
  /** The id sent on `route` (an OpenRouter slug, a gateway's `vendor/model`). */
  modelId: string;
  /** API root for `wire`, no trailing slash. */
  baseURL: string;
  apiKey: string;
  keyScope: InferenceKeyScope;
}

export interface ResolveInferenceRouteOptions {
  vendor: KitProvider;
  model: string;
  teamId: string;
  workspaceId?: string | null;
  userId?: string | null;
  accountId?: string | null;
  keyPolicy?: InferenceKeyPolicy;
}

export interface ResolveInferenceRouteDeps {
  resolveInferenceCredential: (opts: ResolveInferenceKeyOptions) => Promise<ResolvedInferenceCredential | null>;
  resolveLiteLLMGateway: (opts: { teamId: string; workspaceId?: string | null }) => Promise<LiteLLMGateway | null>;
}

const defaultDeps: ResolveInferenceRouteDeps = {
  resolveInferenceCredential: async o => (await import('./inference-keys')).resolveInferenceCredential(o),
  resolveLiteLLMGateway: async o => (await import('./litellm-gateway')).resolveLiteLLMGateway(o),
};

/** The first route that can serve this call, or null when none has a credential. Never throws. */
export async function resolveInferenceRoute(
  opts: ResolveInferenceRouteOptions,
  deps: ResolveInferenceRouteDeps = defaultDeps,
): Promise<ResolvedInferenceRoute | null> {
  for (const route of routeOrder(opts.vendor)) {
    try {
      const hit = route === 'litellm' ? await viaGateway(route, opts, deps) : await viaKey(route, opts, deps);
      if (hit) return hit;
    } catch (e) {
      console.warn(`[inference-route] ${route} lookup failed:`, e);
    }
  }
  return null;
}

async function viaKey(route: RouteId, opts: ResolveInferenceRouteOptions, deps: ResolveInferenceRouteDeps): Promise<ResolvedInferenceRoute | null> {
  const cred = await deps.resolveInferenceCredential({
    provider: route, teamId: opts.teamId, workspaceId: opts.workspaceId,
    userId: opts.userId, accountId: opts.accountId, keyPolicy: opts.keyPolicy,
  });
  if (!cred) return null;
  return {
    route, wire: ROUTES[route].wire, vendor: opts.vendor, model: opts.model,
    modelId: routeModelId(route, opts.vendor, opts.model),
    baseURL: ROUTES[route].baseURL!, apiKey: cred.key, keyScope: cred.scope,
  };
}

async function viaGateway(route: 'litellm', opts: ResolveInferenceRouteOptions, deps: ResolveInferenceRouteDeps): Promise<ResolvedInferenceRoute | null> {
  const g = await deps.resolveLiteLLMGateway({ teamId: opts.teamId, workspaceId: opts.workspaceId });
  if (!g) return null;
  return {
    route, wire: ROUTES[route].wire, vendor: opts.vendor, model: opts.model,
    modelId: routeModelId(route, opts.vendor, opts.model),
    baseURL: g.baseURL, apiKey: g.apiKey, keyScope: 'team',
  };
}

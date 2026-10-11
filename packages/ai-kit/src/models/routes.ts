/**
 * Model routes: where a call to a model is sent. Pure, no SDK imports.
 *
 * Two different things are both called "provider":
 *
 * - the **vendor** (`KitProvider`): who makes the model and what it costs.
 *   Tiers, plans and receipts name the vendor and its native model id.
 * - the **route** (`RouteId`): the API the bytes go to, with which key, in
 *   which wire format. A vendor's own API is one route; OpenRouter and a
 *   LiteLLM gateway serve many vendors.
 *
 * Each route is one `ROUTES` entry. A new gateway (another proxy, a cloud
 * AI gateway) is a new entry, not a new branch at every call site.
 *
 * Cloudflare AI Gateway is not a `ROUTES` entry yet: it serves decision calls
 * only (Jev through its OpenRouter path, Clef through Workers AI), and its
 * credential is the team's Cloudflare one, not an inference key. The URL
 * helpers are at the bottom of this file.
 *
 * Subscription seats (OAuth) are not routes: they are anchored to a runner and
 * never serve a server-side call.
 */

import type { KitProvider } from './types';

export const ROUTE_IDS = ['anthropic', 'openai', 'openrouter', 'litellm'] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

/** The request format a route speaks for a one-shot or chat call. */
export type RouteWire = 'anthropic-messages' | 'openai-chat';

export interface RouteSpec {
  id: RouteId;
  label: string;
  wire: RouteWire;
  /** API root for `wire`, no trailing slash. Null: the credential carries it (a gateway). */
  baseURL: string | null;
  /** Anthropic-compatible root for agent runs (`ANTHROPIC_BASE_URL`), or null when the route has none of its own. */
  agentBaseURL: string | null;
  auth: 'x-api-key' | 'bearer';
  /** Non-auth headers every call sends. */
  headers: Readonly<Record<string, string>>;
  /** Free read-only endpoint, relative to `baseURL`, that 401s on a bad key. */
  verifyPath: string;
  /** Vendors it can serve. `'any'`: whatever is behind it. */
  vendors: readonly KitProvider[] | 'any';
  /** May a person hold their own key for it? A gateway is a team's shared configuration. */
  personalKeys: boolean;
  /** Takes `HTTP-Referer` / `X-Title` attribution. */
  attribution: boolean;
  /** Returns the call's cost itself (so receipts carry `costUsd`). */
  reportsCost: boolean;
  /** Public key-management hints; never credentials. */
  key?: {
    prefix: string;
    placeholder: string;
    consoleUrl: string;
    envVar: string;
    /**
     * @deprecated Storage facts live in the provider registry
     * (`./provider-registry`); `PROVIDER_KEY_CAPABILITIES` no longer reads
     * this. Kept for one release so consumers do not break; a test holds it
     * equal to the registry's chat-read legacy purposes.
     */
    legacyPurposes?: readonly string[];
    rejectedPrefixes?: readonly string[];
  };
}

export const ROUTES = {
  anthropic: {
    id: 'anthropic', label: 'Anthropic', wire: 'anthropic-messages',
    baseURL: 'https://api.anthropic.com/v1', agentBaseURL: 'https://api.anthropic.com',
    auth: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' }, verifyPath: '/models?limit=1',
    key: { prefix: 'sk-ant-api', placeholder: 'sk-ant-api03-…', consoleUrl: 'https://console.anthropic.com/settings/keys', envVar: 'ANTHROPIC_API_KEY', legacyPurposes: ['anthropic_api_key'], rejectedPrefixes: ['sk-ant-oat'] },
    vendors: ['anthropic'], personalKeys: true, attribution: false, reportsCost: false,
  },
  openai: {
    id: 'openai', label: 'OpenAI', wire: 'openai-chat',
    baseURL: 'https://api.openai.com/v1', agentBaseURL: null,
    auth: 'bearer', headers: {}, verifyPath: '/models',
    key: { prefix: 'sk-', placeholder: 'sk-proj-…', consoleUrl: 'https://platform.openai.com/api-keys', envVar: 'OPENAI_API_KEY' },
    vendors: ['openai'], personalKeys: true, attribution: false, reportsCost: false,
  },
  openrouter: {
    id: 'openrouter', label: 'OpenRouter', wire: 'openai-chat',
    baseURL: 'https://openrouter.ai/api/v1', agentBaseURL: 'https://openrouter.ai/api',
    auth: 'bearer', headers: {}, verifyPath: '/key',
    key: { prefix: 'sk-or-', placeholder: 'sk-or-v1-…', consoleUrl: 'https://openrouter.ai/settings/keys', envVar: 'OPENROUTER_API_KEY', legacyPurposes: ['decision_key'] },
    vendors: 'any', personalKeys: true, attribution: true, reportsCost: true,
  },
  litellm: {
    key: undefined,
    id: 'litellm', label: 'LiteLLM gateway', wire: 'openai-chat',
    baseURL: null, agentBaseURL: null,
    auth: 'bearer', headers: {}, verifyPath: '/models',
    vendors: 'any', personalKeys: false, attribution: false, reportsCost: false,
  },
} satisfies Readonly<Record<RouteId, RouteSpec>>;

export function isRouteId(value: unknown): value is RouteId {
  return typeof value === 'string' && (ROUTE_IDS as readonly string[]).includes(value);
}

export function routeServes(route: RouteId, vendor: KitProvider): boolean {
  const v: RouteSpec['vendors'] = ROUTES[route].vendors;
  return v === 'any' || v.includes(vendor);
}

/**
 * The routes that may serve a vendor's model, in the order to try them: the
 * vendor's own API, then OpenRouter, then the team's gateway. One order for
 * every server-side call site.
 */
export function routeOrder(vendor: KitProvider): RouteId[] {
  const order: RouteId[] = [];
  if ((ROUTE_IDS as readonly string[]).includes(vendor)) order.push(vendor as RouteId);
  for (const r of ROUTE_IDS) {
    if (!order.includes(r) && routeServes(r, vendor)) order.push(r);
  }
  return order;
}

/**
 * The OpenRouter slug for a native model id. OpenRouter writes Anthropic
 * versions with a dot and no snapshot date (`claude-haiku-4-5-20251001` ->
 * `anthropic/claude-haiku-4.5`); OpenAI ids keep their own dots.
 */
export function openRouterModelId(vendor: string, model: string): string {
  if (vendor === 'openrouter' || model.includes('/')) return model;
  if (vendor === 'anthropic') {
    const undated = model.replace(/-\d{8}$/, '');
    return `anthropic/${undated.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
  }
  return `${vendor}/${model}`;
}

/** How a gateway names models: an alias map, else `vendor/model` (LiteLLM's convention), or bare with `prefix: false`. */
export interface GatewayNaming {
  models?: Record<string, string>;
  prefix?: boolean;
}

/** The model id to send on `route` for a vendor's native model. Pure. */
export function routeModelId(route: RouteId, vendor: KitProvider, model: string, naming: GatewayNaming = {}): string {
  switch (route) {
    case 'openrouter': return openRouterModelId(vendor, model);
    case 'litellm': {
      const qualified = `${vendor}/${model}`;
      return naming.models?.[qualified] ?? naming.models?.[model] ?? (naming.prefix === false ? model : qualified);
    }
    default: return model;
  }
}

/** The auth header for a route's key. */
export function routeAuthHeaders(route: RouteId, apiKey: string): Record<string, string> {
  return ROUTES[route].auth === 'x-api-key' ? { 'x-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
}

/** OpenRouter attribution, for routes that take it; `{}` elsewhere. */
export function routeAttributionHeaders(route: RouteId, app: { appName?: string; appUrl?: string }): Record<string, string> {
  if (!ROUTES[route].attribution) return {};
  const h: Record<string, string> = {};
  if (app.appName) h['X-Title'] = app.appName;
  if (app.appUrl) h['HTTP-Referer'] = app.appUrl;
  return h;
}

// ── Cloudflare AI Gateway ────────────────────────────────────────────────────

/** AI Gateway's root; a gateway's URL is `<root>/<accountId>/<gatewayId>/<provider>`. */
export const CLOUDFLARE_AI_GATEWAY_ROOT = 'https://gateway.ai.cloudflare.com/v1';
/** Cloudflare's REST API root, where Workers AI answers without a gateway. */
export const CLOUDFLARE_API_ROOT = 'https://api.cloudflare.com/client/v4';

/** Where a Cloudflare call goes: the account, and the gateway when there is one. */
export interface CloudflareGatewayRef {
  accountId: string;
  gatewayId?: string | null;
}

/** The AI Gateway provider paths buildd uses. `openrouter` proxies OpenRouter (Jev's System One API). */
export type CloudflareGatewayProvider = 'openrouter' | 'workers-ai';

// Account IDs are 32 hex characters; gateway IDs are dashboard slugs.
const CF_ACCOUNT_RE = /^[0-9a-f]{32}$/;
const CF_GATEWAY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function checkRef(ref: CloudflareGatewayRef): void {
  if (!CF_ACCOUNT_RE.test(ref.accountId)) throw new Error('Cloudflare accountId must be the 32-character hex account ID');
  if (ref.gatewayId != null && !CF_GATEWAY_RE.test(ref.gatewayId)) throw new Error('Cloudflare gatewayId must be a gateway slug');
}

/** A gateway's root for one provider, no trailing slash. Throws without a gateway, or on a malformed id. */
export function cloudflareGatewayURL(ref: CloudflareGatewayRef, provider: CloudflareGatewayProvider): string {
  checkRef(ref);
  if (!ref.gatewayId) throw new Error('cloudflareGatewayURL needs a gatewayId');
  return `${CLOUDFLARE_AI_GATEWAY_ROOT}/${ref.accountId}/${ref.gatewayId}/${provider}`;
}

/**
 * The Workers AI root a model path is appended to: through the gateway when
 * the ref names one (logged, cached, rate-limited there), else the REST API.
 */
export function cloudflareWorkersAiURL(ref: CloudflareGatewayRef): string {
  checkRef(ref);
  return ref.gatewayId
    ? cloudflareGatewayURL(ref, 'workers-ai')
    : `${CLOUDFLARE_API_ROOT}/accounts/${ref.accountId}/ai/run`;
}

/**
 * A team's LiteLLM gateway: one OpenAI-compatible proxy that serves the tier
 * models (and any open-weights decision model) with one key.
 *
 * ## Storage
 *
 * One `secrets` row (no per-integration table, `docs/credentials-architecture.md`):
 * purpose `inference_key`, label `litellm`, and the encrypted value a JSON blob
 * `{ "apiKey": "...", "baseUrl": "https://..." }`. Team-wide (`userId`,
 * `accountId` NULL), optionally narrowed to a workspace. There is no personal
 * gateway: a proxy is an organisation's, and its URL is shared configuration.
 *
 * ## Where it is used
 *
 * A fallback, never a detour: a call site uses the provider's own key when one
 * resolves, then OpenRouter (chat), then the gateway. Through the gateway a
 * plan's model is sent as `provider/model` (LiteLLM's convention), via
 * `gatewayModel` from `@builddai/ai-kit/models`. Decision calls use it when the
 * team's decision model says `via: 'litellm'` (`decision-model.ts`).
 *
 * The team's key policy binds it like any shared key: under `own` nothing
 * shared is spent, so the gateway resolves to null.
 *
 * ## Module loading
 *
 * Pure helpers at the top; the DB and decryption are imported lazily in the
 * resolver, so the parse/validate helpers load in a plain bun process.
 */

import {
  LOCAL_DEV_HOSTS, isIpLiteral, isPublicAddress, localDevHostsAllowed, verifyByFetch,
  type LookupAll, type VerifyOutcome,
} from './net/public-address';

import type { CredentialPolicy } from './inference-key-policy';
import type { PolicyScope } from './providers/policy';

export const LITELLM_LABEL = 'litellm' as const;

/** A gateway is an organisation's: never personal or account-scoped, never an env var. */
const GATEWAY_SCOPES: readonly PolicyScope[] = ['workspace', 'team'];

export interface LiteLLMGateway {
  /** OpenAI-compatible root, no trailing slash, e.g. `https://litellm.example.com/v1`. */
  baseURL: string;
  apiKey: string;
}

/**
 * Why a base URL can't be a gateway (or an agent endpoint), or null: https
 * to a host that is not an IP literal outside public space; no userinfo, query
 * or fragment. http, and the loopback hosts, only outside production
 * (LOCAL_DEV_HOSTS). Where the host resolves is checked at verification time
 * (net/public-address).
 */
export function gatewayUrlProblem(raw: string, opts: { allowLocal?: boolean } = {}): string | null {
  const allowLocal = opts.allowLocal ?? localDevHostsAllowed();
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'That is not a URL.';
  }
  if (url.username || url.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(trimmed)) {
    return 'Put the key in the key field, not in the URL.';
  }
  // `new URL` drops a bare `?` or `#`, so check the raw string too.
  if (url.search || url.hash || trimmed.includes('?') || trimmed.includes('#')) {
    return 'The URL must not have a query or fragment.';
  }
  const host = url.hostname.toLowerCase();
  if (LOCAL_DEV_HOSTS.includes(host)) {
    if (!allowLocal) return 'The URL must be a public https address.';
    return url.protocol === 'https:' || url.protocol === 'http:' ? null : 'The gateway URL must use https.';
  }
  if (url.protocol !== 'https:') return 'The gateway URL must use https.';
  if (host === 'localhost' || host.endsWith('.localhost') || (isIpLiteral(host) && !isPublicAddress(host))) {
    return 'The URL must be a public https address.';
  }
  return null;
}

export function normalizeGatewayUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** The stored secret value. */
export function serializeGateway(g: LiteLLMGateway): string {
  return JSON.stringify({ apiKey: g.apiKey, baseUrl: normalizeGatewayUrl(g.baseURL) });
}

/** The decrypted secret value, or null when it is not a well-formed gateway. */
export function parseGateway(value: string | null | undefined): LiteLLMGateway | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as { apiKey?: unknown; baseUrl?: unknown };
    if (typeof v.apiKey !== 'string' || !v.apiKey || typeof v.baseUrl !== 'string') return null;
    if (gatewayUrlProblem(v.baseUrl)) return null;
    return { apiKey: v.apiKey, baseURL: normalizeGatewayUrl(v.baseUrl) };
  } catch {
    return null;
  }
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Check a gateway with its free `GET /models` (net/public-address
 * verifyByFetch: public hosts only, no redirects, no reply text). 401/403 ⇒
 * `revoked`; anything else that isn't a 2xx is `unknown`, so an outage never
 * marks it dead. `blocked`: the URL itself may not be used.
 */
export async function verifyGateway(
  g: LiteLLMGateway,
  opts: { fetcher?: Fetcher; timeoutMs?: number; lookup?: LookupAll } = {},
): Promise<VerifyOutcome> {
  return verifyByFetch('gateway', `${g.baseURL}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${g.apiKey}` },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
  }, { fetcher: opts.fetcher, lookup: opts.lookup });
}

/**
 * The gateway a call for this team (and workspace) may use: a workspace row
 * first, then the team's. Null when there is none, it can't be decrypted or
 * parsed, or the key policy is `own`. Never throws.
 */
export async function resolveLiteLLMGateway(
  opts: { teamId: string; workspaceId?: string | null },
  /**
   * `ignoreKeyPolicy`: only for the agent model endpoint's `{ kind: 'gateway' }`
   * reference (agent-endpoint.ts). The key policy governs server-side inference
   * spend; agent runs are not bound by it (docs/design/agent-model-endpoint.md §1).
   */
  flags: { ignoreKeyPolicy?: boolean } = {},
): Promise<LiteLLMGateway | null> {
  try {
    const { decrypt } = await import('./secrets');
    const { toCredentialPolicy } = await import('./inference-key-policy');
    let credentialPolicy: CredentialPolicy = 'team';
    if (!flags.ignoreKeyPolicy) {
      const { loadInferenceKeyPolicy } = await import('./inference-keys');
      const policy = await loadInferenceKeyPolicy(opts.teamId);
      if (policy === 'own') return null;
      credentialPolicy = toCredentialPolicy(policy);
    }
    // The resolver's chat ranking, narrowed to the shared scopes a gateway can
    // sit in: workspace row first, then the team's; healthy over revoked;
    // newest. A row that does not parse as a gateway is skipped.
    const { resolveProviderCredential } = await import('./providers/resolve');
    const result = await resolveProviderCredential({
      teamId: opts.teamId,
      workspaceId: opts.workspaceId ?? null,
      accountId: null,
      requesterUserId: null,
      surface: 'chat',
      provider: 'litellm',
      scopes: GATEWAY_SCOPES,
      team: { credentialPolicy },
      accept: v => parseGateway(v) !== null,
      decrypt,
    });
    if (!result.none) return parseGateway(result.credential.value);
  } catch (e) {
    console.warn('[litellm-gateway] lookup failed:', e);
  }
  return null;
}

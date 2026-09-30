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

export const LITELLM_LABEL = 'litellm' as const;

export interface LiteLLMGateway {
  /** OpenAI-compatible root, no trailing slash, e.g. `https://litellm.example.com/v1`. */
  baseURL: string;
  apiKey: string;
}

/** Why a base URL can't be a gateway, or null. https only, except localhost. */
export function gatewayUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'That is not a URL.';
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return 'The gateway URL must use https.';
  if (url.username || url.password) return 'Put the key in the key field, not in the URL.';
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
 * Check a gateway with its free `GET /models`. 401/403 ⇒ `revoked`; anything
 * else that isn't a 200 is `unknown`, so an outage never marks it dead.
 */
export async function verifyGateway(
  g: LiteLLMGateway,
  opts: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<{ health: 'healthy' | 'revoked' | 'unknown'; error: string | null }> {
  const fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
  const scrub = (s: string) => s.split(g.apiKey).join('[key]').slice(0, 200);
  try {
    const res = await fetcher(`${g.baseURL}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${g.apiKey}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (res.ok) return { health: 'healthy', error: null };
    if (res.status === 401 || res.status === 403) return { health: 'revoked', error: `gateway rejected the key (HTTP ${res.status})` };
    return { health: 'unknown', error: `gateway returned HTTP ${res.status}` };
  } catch (e) {
    return { health: 'unknown', error: scrub(`could not reach the gateway: ${e instanceof Error ? e.message : String(e)}`) };
  }
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
    const { db } = await import('./db');
    const { secrets } = await import('./db/schema');
    const { and, eq, isNull, or, sql } = await import('drizzle-orm');
    const { decrypt } = await import('./secrets');
    if (!flags.ignoreKeyPolicy) {
      const { loadInferenceKeyPolicy } = await import('./inference-keys');
      if ((await loadInferenceKeyPolicy(opts.teamId)) === 'own') return null;
    }
    const rows = await db.query.secrets.findMany({
      where: and(
        eq(secrets.teamId, opts.teamId),
        eq(secrets.purpose, 'inference_key'),
        eq(secrets.label, LITELLM_LABEL),
        isNull(secrets.userId),
        isNull(secrets.accountId),
        or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
      ),
      columns: { id: true, encryptedValue: true, workspaceId: true, healthStatus: true, updatedAt: true },
    });
    const ranked = rows.sort((a, b) =>
      (a.workspaceId ? 0 : 1) - (b.workspaceId ? 0 : 1) ||
      (a.healthStatus === 'revoked' ? 1 : 0) - (b.healthStatus === 'revoked' ? 1 : 0) ||
      (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
    for (const r of ranked) {
      try {
        const g = parseGateway(decrypt(r.encryptedValue));
        if (g) return g;
      } catch (e) {
        console.error(`[litellm-gateway] failed to decrypt secret ${r.id}:`, e);
      }
    }
  } catch (e) {
    console.warn('[litellm-gateway] lookup failed:', e);
  }
  return null;
}

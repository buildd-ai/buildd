/**
 * A team's Cloudflare credential, read for decision calls: Clef on Workers AI,
 * and Jev through the team's AI Gateway.
 *
 * ## Storage
 *
 * The existing team-wide `secrets` row with purpose `cloudflare_token` (the
 * cloud runner's; no new table, `docs/credentials-architecture.md`), an
 * encrypted JSON blob `{ apiToken, accountId, aiGatewayId? }`. It is set and
 * verified from Settings (apps/web `cloudflare-credential.ts`). The token
 * needs Workers AI Read for Clef, and AI Gateway Run when the gateway is
 * authenticated.
 *
 * ## Where it is used
 *
 * Only when the team's decision model says `via: 'cloudflare'`
 * (`decision-model.ts`):
 *
 * - **Clef**: the token is the key; the call goes through the gateway when
 *   `aiGatewayId` is set (logged and rate-limited there), else straight to
 *   Workers AI.
 * - **Jev**: needs `aiGatewayId`. The key is still the team's OpenRouter key;
 *   the gateway proxies OpenRouter's System One API, and the token goes in
 *   `cf-aig-authorization` for an authenticated gateway.
 *
 * The team's key policy binds it like any shared key: under `own` nothing
 * shared is spent, so this resolves to null. A row marked revoked is skipped.
 *
 * ## Module loading
 *
 * Pure helpers at the top; the DB and decryption are imported lazily in the
 * resolver, so the parse helpers load in a plain bun process.
 */

import { CLOUDFLARE_AI_GATEWAY_ROOT, cloudflareGatewayURL, cloudflareWorkersAiURL } from '@builddai/ai-kit/models/routes';

export const CLOUDFLARE_TOKEN_PURPOSE = 'cloudflare_token' as const;

export interface CloudflareAiGateway {
  apiToken: string;
  accountId: string;
  /** Null: no AI Gateway, so Clef goes straight to Workers AI and Jev cannot use Cloudflare. */
  gatewayId: string | null;
}

const ACCOUNT_RE = /^[0-9a-f]{32}$/;
const GATEWAY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_\-.]{20,200}$/;

/** The decrypted secret value, or null when it is not a well-formed Cloudflare credential. */
export function parseCloudflareAiGateway(value: string | null | undefined): CloudflareAiGateway | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as { apiToken?: unknown; accountId?: unknown; aiGatewayId?: unknown };
    if (typeof v.apiToken !== 'string' || !TOKEN_RE.test(v.apiToken)) return null;
    if (typeof v.accountId !== 'string' || !ACCOUNT_RE.test(v.accountId)) return null;
    const gw = typeof v.aiGatewayId === 'string' && v.aiGatewayId ? v.aiGatewayId : null;
    if (gw !== null && !GATEWAY_RE.test(gw)) return null;
    return { apiToken: v.apiToken, accountId: v.accountId, gatewayId: gw };
  } catch {
    return null;
  }
}

/** Where Clef is called: the gateway's Workers AI path, or Workers AI itself. */
export function clefBaseURL(cf: CloudflareAiGateway): string {
  return cloudflareWorkersAiURL({ accountId: cf.accountId, gatewayId: cf.gatewayId });
}

/** The gateway's OpenRouter root for Jev's System One API (the SDK appends `/v1/systemone`), or null without a gateway. */
export function jevGatewayBaseURL(cf: CloudflareAiGateway): string | null {
  return cf.gatewayId ? cloudflareGatewayURL({ accountId: cf.accountId, gatewayId: cf.gatewayId }, 'openrouter') : null;
}

/**
 * A gateway's provider root for agent runs: `anthropic` (the Messages API;
 * Claude Code appends `/v1/messages`) or `openrouter`. Null without a gateway.
 */
export function agentGatewayBaseURL(cf: Pick<CloudflareAiGateway, 'accountId' | 'gatewayId'>, upstream: 'anthropic' | 'openrouter'): string | null {
  if (!cf.gatewayId) return null;
  return upstream === 'openrouter'
    ? cloudflareGatewayURL({ accountId: cf.accountId, gatewayId: cf.gatewayId }, 'openrouter')
    : `${CLOUDFLARE_AI_GATEWAY_ROOT}/${cf.accountId}/${cf.gatewayId}/anthropic`;
}

/** The header an authenticated AI Gateway checks. Harmless on an open gateway. */
export function gatewayAuthHeaders(cf: CloudflareAiGateway): Record<string, string> {
  return { 'cf-aig-authorization': `Bearer ${cf.apiToken}` };
}

/**
 * The team's Cloudflare credential: the newest team-wide row that is not
 * revoked and parses. Null under the `own` key policy, without one, or on any
 * failure. Never throws.
 *
 * `ignoreKeyPolicy`: only for the agent endpoint's `cloudflare` kind, which
 * reads the account and gateway ids and never the token (agent runs are not
 * bound by the inference key policy, docs/design/agent-model-endpoint.md §1).
 */
export async function resolveCloudflareAiGateway(
  opts: { teamId: string },
  flags: { ignoreKeyPolicy?: boolean } = {},
): Promise<CloudflareAiGateway | null> {
  try {
    if (!flags.ignoreKeyPolicy) {
      const { loadInferenceKeyPolicy } = await import('./inference-keys');
      if (await loadInferenceKeyPolicy(opts.teamId) === 'own') return null;
    }
    const { db } = await import('./db');
    const { secrets } = await import('./db/schema');
    const { and, desc, eq, isNull } = await import('drizzle-orm');
    const { decrypt } = await import('./secrets');
    const rows = await db.query.secrets.findMany({
      where: and(
        eq(secrets.teamId, opts.teamId),
        eq(secrets.purpose, CLOUDFLARE_TOKEN_PURPOSE),
        isNull(secrets.workspaceId),
        isNull(secrets.userId),
      ),
      orderBy: desc(secrets.updatedAt),
      columns: { encryptedValue: true, healthStatus: true },
      limit: 5,
    });
    for (const row of rows) {
      if (row.healthStatus === 'revoked') continue;
      let plain: string | null = null;
      try { plain = decrypt(row.encryptedValue); } catch { continue; }
      const cf = parseCloudflareAiGateway(plain);
      if (cf) return cf;
    }
  } catch (e) {
    console.warn('[cloudflare-ai-gateway] lookup failed:', e);
  }
  return null;
}

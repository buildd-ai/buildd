/**
 * The one resolver for API-token model keys.
 *
 * Chat turns (`knowledge-base: buildd/design/agent-chat.md`), inference calls
 * (`inference-client.ts`) and decision calls (`decision-client.ts`) all spend a
 * metered API key, never a subscription seat. They all resolve it here, so one
 * OpenRouter key serves chat, judgments and decisions alike.
 *
 * ## Where keys live
 *
 * `secrets` rows (no per-integration table — `docs/credentials-architecture.md`):
 *
 * - `inference_key`, provider in `label` (`anthropic` | `openai` | `openrouter`)
 *   — the canonical form.
 * - `anthropic_api_key` — accepted for Anthropic, so a team that pasted a key for
 *   worker runs doesn't paste it twice.
 * - `decision_key` — the original OpenRouter purpose for decision calls,
 *   accepted for OpenRouter for backwards compatibility.
 *
 * ## Precedence, most specific first
 *
 * 1. the caller's own key (`userId` = caller) — a person's key, which they pay for;
 * 2. the calling API account's key (`accountId` = caller), as decision calls did;
 * 3. the workspace key (`workspaceId` = W);
 * 4. the team key (`userId`, `accountId`, `workspaceId` all NULL);
 * 5. a legacy account-scoped row, only for callers with no account of their own
 *    (cron/inference paths have always used these);
 * 6. the provider env var, only outside production (or when a self-hosted
 *    deploy opts in with `BUILDD_ALLOW_ENV_INFERENCE_KEYS=1`).
 *
 * Within a scope: purpose preference, healthy over revoked, newest first.
 *
 * ## The team's key policy (`teams.inferenceKeyPolicy`)
 *
 * Binds every server-side call (chat, decision calls, server-side features):
 *
 * - `team`: the team key pays for everyone; a person's own key is ignored.
 * - `team_or_own`: a person's own key wins, the team key covers the rest.
 * - `own`: only the person's own key. No workspace, team, account or env
 *   fallback, so a member without a key gets null and chat says so, and team
 *   work with no person (grading, visual QA, cron) gets null and runs on a runner.
 *
 * ## Invariants
 *
 * - A key never reaches a provider it wasn't issued for. Purpose and label are
 *   re-checked in JS, not trusted to the `where`.
 * - A personal key never serves anyone but its owner, including callers with no
 *   user at all (cron, API keys).
 * - OAuth rows (`oauth_token`, `claude_credential`) are never consulted: an
 *   API-token call has no seat to anchor subscription auth to.
 */

import { db } from './db';
import { teams } from './db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from './secrets';
import { effectiveKeyPolicy, toCredentialPolicy, type InferenceKeyPolicy } from './inference-key-policy';
import type { PolicyScope } from './providers/policy';
import { ROUTES, routeAuthHeaders } from '@builddai/ai-kit/models/routes';

import { PERSONAL_KEY_PROVIDERS, isPersonalKeyProvider, providerKeyCapability, type PersonalKeyProvider } from '@builddai/ai-kit/models/provider-keys';

export type InferenceKeyProvider = PersonalKeyProvider;
export const INFERENCE_KEY_PROVIDERS = PERSONAL_KEY_PROVIDERS;
export const INFERENCE_KEY_PURPOSE = 'inference_key' as const;

export { INFERENCE_KEY_POLICIES, isInferenceKeyPolicy, policyAllowsOwnKey, type InferenceKeyPolicy } from './inference-key-policy';

/**
 * The team's policy. An unreadable row reads as `team_or_own`, the behaviour
 * before the policy existed, so a lookup blip neither strands a person's own
 * key nor invents a refusal.
 */
export async function loadInferenceKeyPolicy(teamId: string): Promise<InferenceKeyPolicy> {
  try {
    const row = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { inferenceKeyPolicy: true, credentialPolicy: true } });
    return effectiveKeyPolicy(row) ?? 'team_or_own';
  } catch {
    return 'team_or_own';
  }
}

export function isInferenceKeyProvider(value: unknown): value is InferenceKeyProvider {
  return isPersonalKeyProvider(value);
}

/**
 * May an env var stand in for a stored key? Never in production unless the
 * deploy opts in, so a stray Vercel env var can't start spending on every team.
 */
export function envKeysAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.BUILDD_ALLOW_ENV_INFERENCE_KEYS === '1';
}

export interface ResolveInferenceKeyOptions {
  /** Anything else (e.g. `openai-codex`) has no API-key form and resolves to null. */
  provider: InferenceKeyProvider | string;
  teamId: string;
  workspaceId?: string | null;
  /** The signed-in person the call is for. Personal keys match only this. */
  userId?: string | null;
  /** The API-key account the call is for (decision calls from task creation). */
  accountId?: string | null;
  /**
   * Preference order among the provider's accepted purposes. Filtered against
   * the provider's set, so it can reorder but never widen what's accepted.
   */
  purposes?: readonly string[];
  /**
   * The team's key policy, when the caller already loaded it. Omitted with a
   * `userId`, the resolver reads it itself: it is enforced here, not by callers.
   */
  keyPolicy?: InferenceKeyPolicy;
}

export type InferenceKeyScope = 'user' | 'account' | 'workspace' | 'team' | 'env';

export interface ResolvedInferenceCredential {
  key: string;
  /** Actual API provider, independent of the owner of the credential. */
  provider: InferenceKeyProvider;
  scope: InferenceKeyScope;
  /** Null for env. */
  secretId: string | null;
  purpose: string | null;
}

/** The resolver's scope, in this module's vocabulary (`personal` was always `user` here). */
const SCOPE: Record<PolicyScope, InferenceKeyScope> = {
  personal: 'user', account: 'account', workspace: 'workspace', team: 'team', env: 'env',
};

/**
 * A thin wrapper over `resolveProviderCredential` (`./providers/resolve`) on
 * the chat surface: the precedence above is that resolver's chat ranking, and
 * the parity tables in `__tests__/provider-resolve.test.ts` hold them equal.
 */
export async function resolveInferenceCredential(
  opts: ResolveInferenceKeyOptions,
): Promise<ResolvedInferenceCredential | null> {
  if (!isInferenceKeyProvider(opts.provider)) return null;
  const provider = opts.provider;
  const accepted = providerKeyCapability(provider)!.purposes;
  const purposes = opts.purposes
    ? [...opts.purposes.filter(p => accepted.includes(p)), ...accepted.filter(p => !opts.purposes!.includes(p))]
    : accepted;

  // The policy binds every call. With no person, `own` leaves nothing to spend
  // (no own key, no shared fallback), so team work takes its runner path.
  const policy: InferenceKeyPolicy = opts.keyPolicy ?? await loadInferenceKeyPolicy(opts.teamId);

  const { resolveProviderCredential } = await import('./providers/resolve');
  const result = await resolveProviderCredential({
    teamId: opts.teamId,
    workspaceId: opts.workspaceId ?? null,
    accountId: opts.accountId ?? null,
    requesterUserId: opts.userId ?? null,
    surface: 'chat',
    provider,
    purposes,
    team: { credentialPolicy: toCredentialPolicy(policy) },
    decrypt,
  });
  if (result.none) return null;
  return {
    provider,
    key: result.credential.value,
    scope: SCOPE[result.scope],
    secretId: result.source.secretId,
    purpose: result.source.purpose,
  };
}

/** The key alone. See `resolveInferenceCredential` for where it came from. */
export async function resolveInferenceKey(opts: ResolveInferenceKeyOptions): Promise<string | null> {
  return (await resolveInferenceCredential(opts))?.key ?? null;
}

/**
 * The team's billing model for server-side features: does team work (no
 * person) resolve a pay-per-token key for any provider, or a LiteLLM gateway,
 * under the team's key policy? True → server-side by default; false (subscription only, or `own`)
 * → the runner. Personal keys never count.
 */
export async function hasTeamInferenceKey(teamId: string): Promise<boolean> {
  const keyPolicy = await loadInferenceKeyPolicy(teamId);
  for (const provider of INFERENCE_KEY_PROVIDERS) {
    if (await resolveInferenceCredential({ provider, teamId, keyPolicy })) return true;
  }
  // A LiteLLM gateway serves the tier models too (litellm-gateway.ts).
  const { resolveLiteLLMGateway } = await import('./litellm-gateway');
  return (await resolveLiteLLMGateway({ teamId })) !== null;
}

// ── Display and health ────────────────────────────────────────────────────────

/**
 * The last four characters, for "…a1b2". Values too short to spare four
 * characters without revealing most of the key return ''.
 */
export function maskKeyLast4(value: string): string {
  const v = value.trim();
  return v.length >= 8 ? v.slice(-4) : '';
}

export type ProviderKeyHealth = 'healthy' | 'revoked' | 'unknown';

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Check a key against a free, read-only provider endpoint. 401/403 means the
 * key is bad (`revoked`); anything else that isn't a 200 is `unknown` — a
 * provider outage must never mark a working key dead.
 */
export async function verifyProviderKey(
  provider: InferenceKeyProvider,
  key: string,
  opts: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<{ health: ProviderKeyHealth; error: string | null }> {
  const fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
  const route = ROUTES[provider];
  const verification = providerKeyCapability(provider)!.verification;
  const url = `${verification.baseURL}${verification.path}`;
  const headers = { ...routeAuthHeaders(provider, key), ...route.headers };
  const scrub = (s: string) => (key ? s.split(key).join('[key]') : s).slice(0, 200);
  try {
    const res = await fetcher(url, { method: verification.method, headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
    if (res.ok) return { health: 'healthy', error: null };
    if (verification.rejectedStatuses.includes(res.status)) {
      return { health: 'revoked', error: `provider rejected the key (HTTP ${res.status})` };
    }
    return { health: 'unknown', error: `provider returned HTTP ${res.status}` };
  } catch (e) {
    return { health: 'unknown', error: scrub(`could not reach provider: ${e instanceof Error ? e.message : String(e)}`) };
  }
}

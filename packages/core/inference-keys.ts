/**
 * The one resolver for API-token model keys.
 *
 * Chat turns (`docs/design/agent-chat.md`), inference calls
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
import { secrets } from './db/schema';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { decrypt } from './secrets';

/** Providers with an API-key form. */
export type InferenceKeyProvider = 'anthropic' | 'openai' | 'openrouter';

export const INFERENCE_KEY_PROVIDERS: readonly InferenceKeyProvider[] = ['anthropic', 'openai', 'openrouter'];

export const INFERENCE_KEY_PURPOSE = 'inference_key' as const;

/** Accepted purposes per provider, in default preference order. */
const PROVIDER_PURPOSES: Record<InferenceKeyProvider, readonly string[]> = {
  anthropic: [INFERENCE_KEY_PURPOSE, 'anthropic_api_key'],
  openai: [INFERENCE_KEY_PURPOSE],
  openrouter: [INFERENCE_KEY_PURPOSE, 'decision_key'],
};

const ENV_VAR: Record<InferenceKeyProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export function isInferenceKeyProvider(value: unknown): value is InferenceKeyProvider {
  return typeof value === 'string' && (INFERENCE_KEY_PROVIDERS as readonly string[]).includes(value);
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
}

export type InferenceKeyScope = 'user' | 'account' | 'workspace' | 'team' | 'env';

export interface ResolvedInferenceCredential {
  key: string;
  scope: InferenceKeyScope;
  /** Null for env. */
  secretId: string | null;
  purpose: string | null;
}

interface CandidateRow {
  id: string;
  purpose: string;
  label: string | null;
  encryptedValue: string;
  accountId: string | null;
  userId: string | null;
  workspaceId: string | null;
  healthStatus: string;
  updatedAt: Date | null;
}

/** Rank of a row for this caller, or null when it must not be used at all. */
function scopeRank(r: CandidateRow, opts: ResolveInferenceKeyOptions): { rank: number; scope: InferenceKeyScope } | null {
  if (r.userId != null) {
    return opts.userId && r.userId === opts.userId ? { rank: 0, scope: 'user' } : null;
  }
  if (r.workspaceId != null && r.workspaceId !== opts.workspaceId) return null;
  if (r.accountId != null) {
    if (opts.accountId) return r.accountId === opts.accountId ? { rank: 1, scope: 'account' } : null;
    return { rank: 4, scope: 'account' };
  }
  if (r.workspaceId != null) return { rank: 2, scope: 'workspace' };
  return { rank: 3, scope: 'team' };
}

export async function resolveInferenceCredential(
  opts: ResolveInferenceKeyOptions,
): Promise<ResolvedInferenceCredential | null> {
  if (!isInferenceKeyProvider(opts.provider)) return null;
  const provider = opts.provider;
  const accepted = PROVIDER_PURPOSES[provider];
  const purposes = opts.purposes
    ? [...opts.purposes.filter(p => accepted.includes(p)), ...accepted.filter(p => !opts.purposes!.includes(p))]
    : accepted;

  let rows: CandidateRow[] = [];
  try {
    rows = (await db.query.secrets.findMany({
      where: and(
        eq(secrets.teamId, opts.teamId),
        or(...purposes.map(p => eq(secrets.purpose, p as never))),
        or(isNull(secrets.userId), opts.userId ? eq(secrets.userId, opts.userId) : sql`false`),
        or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
      ),
      columns: {
        id: true, purpose: true, label: true, encryptedValue: true, accountId: true,
        userId: true, workspaceId: true, healthStatus: true, updatedAt: true,
      },
    })) as CandidateRow[];
  } catch (e) {
    console.warn('[inference-keys] key lookup failed:', e);
  }

  const ranked = rows
    .filter(r =>
      purposes.includes(r.purpose) &&
      (r.purpose !== INFERENCE_KEY_PURPOSE || (r.label ?? '').toLowerCase() === provider),
    )
    .map(r => ({ r, s: scopeRank(r, opts) }))
    .filter((x): x is { r: CandidateRow; s: { rank: number; scope: InferenceKeyScope } } => x.s !== null)
    .sort((a, b) =>
      a.s.rank - b.s.rank ||
      purposes.indexOf(a.r.purpose) - purposes.indexOf(b.r.purpose) ||
      (a.r.healthStatus === 'revoked' ? 1 : 0) - (b.r.healthStatus === 'revoked' ? 1 : 0) ||
      (b.r.updatedAt?.getTime() ?? 0) - (a.r.updatedAt?.getTime() ?? 0),
    );

  for (const { r, s } of ranked) {
    try {
      const value = decrypt(r.encryptedValue);
      if (value) return { key: value, scope: s.scope, secretId: r.id, purpose: r.purpose };
    } catch (e) {
      console.error(`[inference-keys] failed to decrypt secret ${r.id}:`, e);
    }
  }

  if (envKeysAllowed()) {
    const value = process.env[ENV_VAR[provider]];
    if (value) return { key: value, scope: 'env', secretId: null, purpose: null };
  }
  return null;
}

/** The key alone. See `resolveInferenceCredential` for where it came from. */
export async function resolveInferenceKey(opts: ResolveInferenceKeyOptions): Promise<string | null> {
  return (await resolveInferenceCredential(opts))?.key ?? null;
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
  const req: Record<InferenceKeyProvider, { url: string; headers: Record<string, string> }> = {
    anthropic: {
      url: 'https://api.anthropic.com/v1/models?limit=1',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    },
    openai: { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } },
    openrouter: { url: 'https://openrouter.ai/api/v1/key', headers: { Authorization: `Bearer ${key}` } },
  };
  const { url, headers } = req[provider];
  const scrub = (s: string) => (key ? s.split(key).join('[key]') : s).slice(0, 200);
  try {
    const res = await fetcher(url, { method: 'GET', headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
    if (res.ok) return { health: 'healthy', error: null };
    if (res.status === 401 || res.status === 403) {
      return { health: 'revoked', error: `provider rejected the key (HTTP ${res.status})` };
    }
    return { health: 'unknown', error: `provider returned HTTP ${res.status}` };
  } catch (e) {
    return { health: 'unknown', error: scrub(`could not reach provider: ${e instanceof Error ? e.message : String(e)}`) };
  }
}

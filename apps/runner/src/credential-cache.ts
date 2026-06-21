/**
 * In-memory, per-team server-managed credential cache.
 *
 * Server-managed Claude credentials (OAuth token / API key) are delivered
 * inline on every claim response. To let a runner with ZERO local credentials
 * run entirely off server-injected creds — and to survive between claims —
 * we cache the most-recently-delivered credential per team IN MEMORY ONLY.
 *
 * Why in-memory only: a stale credential written to disk was the source of the
 * bug this kills (a rotated/expired token lingering on disk and being preferred
 * over a fresh server-injected one). NEVER persist this to disk.
 *
 * Behaviour:
 *   - `set(teamId, cred)` populates/refreshes from the claim payload.
 *   - `get(teamId)` returns the cred only when fresh (younger than TTL);
 *     a stale entry returns undefined so the caller refreshes from the next
 *     claim's payload.
 *   - `invalidate(teamId)` drops the entry on a 401 for that team, so a
 *     rotated/fixed credential is picked up promptly rather than serving a
 *     cached-bad one.
 */

export interface ServerCredential {
  oauthToken?: string;
  apiKey?: string;
  /** Epoch ms the credential was fetched/delivered. */
  fetchedAt: number;
}

/** Default freshness window for a cached server credential (~3h). */
export const DEFAULT_SERVER_CRED_TTL_MS = 3 * 60 * 60 * 1000;

function resolveTtl(): number {
  const raw = process.env.SERVER_CRED_TTL_MS;
  if (!raw) return DEFAULT_SERVER_CRED_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SERVER_CRED_TTL_MS;
}

export class CredentialCache {
  private entries = new Map<string, ServerCredential>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = resolveTtl()) {
    this.ttlMs = ttlMs;
  }

  /**
   * Populate/refresh the cache for a team from a claim payload. A credential
   * with neither token nor key is ignored (nothing useful to cache).
   */
  set(teamId: string, cred: { oauthToken?: string; apiKey?: string }, now: number = Date.now()): void {
    if (!teamId) return;
    if (!cred.oauthToken && !cred.apiKey) return;
    this.entries.set(teamId, {
      oauthToken: cred.oauthToken,
      apiKey: cred.apiKey,
      fetchedAt: now,
    });
  }

  /**
   * Return the cached credential for a team when fresh. Entries older than the
   * TTL are treated as stale: dropped and reported as a miss so the caller
   * refreshes from the next claim payload.
   */
  get(teamId: string, now: number = Date.now()): ServerCredential | undefined {
    if (!teamId) return undefined;
    const entry = this.entries.get(teamId);
    if (!entry) return undefined;
    if (now - entry.fetchedAt >= this.ttlMs) {
      this.entries.delete(teamId);
      return undefined;
    }
    return entry;
  }

  /** Invalidate a team's entry (e.g. after a 401 for that team). */
  invalidate(teamId: string): void {
    this.entries.delete(teamId);
  }

  /** True when a fresh entry exists for the team. */
  has(teamId: string, now: number = Date.now()): boolean {
    return this.get(teamId, now) !== undefined;
  }

  get ttl(): number {
    return this.ttlMs;
  }
}

/**
 * Exponential backoff for the auth-failure burn-loop guard.
 *
 * A runner with neither local nor valid server credentials would otherwise
 * claim-then-fail forever. Each consecutive auth failure doubles the pause
 * window (capped), and a credential change / success resets it. Pure function
 * so it is unit-testable without a live runner.
 *
 * @param failureCount 1-based count of consecutive auth failures.
 */
export function authBackoffMs(
  failureCount: number,
  opts: { baseMs?: number; maxMs?: number } = {},
): number {
  const baseMs = opts.baseMs ?? 60 * 1000; // 1 min
  const maxMs = opts.maxMs ?? 30 * 60 * 1000; // 30 min cap
  if (failureCount <= 0) return 0;
  const ms = baseMs * 2 ** (failureCount - 1);
  return Math.min(ms, maxMs);
}

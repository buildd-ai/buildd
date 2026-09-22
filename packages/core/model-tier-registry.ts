/**
 * Model tier registry — resolves premium-plus/premium/standard/budget → concrete provider + model.
 *
 * Resolution chain (first match wins):
 *   1. Workspace override row  (team_id=X, workspace_id=Y, tier=T)
 *   2. Team default row        (team_id=X, workspace_id=NULL, tier=T)
 *   3. Live catalog pick       (newest release in the tier's price band — see
 *                                model-catalog.ts; self-heals without a deploy)
 *   4. TIER_DEFAULTS           (code-level fallback, last resort — catalog empty/failed)
 *
 * Resolution happens at claim time so a registry update affects already-queued tasks
 * within the next 60-second cache window — no deploy needed. The catalog step
 * carries its own 24h cache (model-catalog-cache.ts), so it self-heals on the
 * same "no deploy" property without hitting OpenRouter on every claim.
 *
 * See docs/design/model-tiers.md for the full spec.
 */

import { db } from './db/client';
import { modelTierRegistry } from './db/schema';
import { eq, and, isNull } from 'drizzle-orm';
export type { Tier, TierProvider, TierEntry } from './model-tier-defaults';
export { TIER_DEFAULTS, TIERS } from './model-tier-defaults';
import type { Tier, TierEntry, TierProvider } from './model-tier-defaults';
import { TIER_DEFAULTS, TIERS } from './model-tier-defaults';
import { pickTierModel } from './model-catalog';
import { getCachedOpenRouterCatalog } from './model-catalog-cache';
import { checkModelClientCapability } from './model-capability-requirements';

/** Maps the model-router's legacy alias vocabulary to the new tier vocabulary. */
export function mapRouterAlias(alias: string): Tier {
  if (alias === 'opus')   return 'premium';
  if (alias === 'haiku')  return 'budget';
  return 'standard'; // 'sonnet' and anything else → standard
}

// In-memory cache keyed by `${teamId}:${workspaceId ?? 'null'}`.
// Flushed on any registry write via invalidateTierCache.
const CACHE_TTL_MS = 60 * 1000; // 60 seconds
const cache = new Map<string, { entries: Map<Tier, TierEntry>; loadedAt: number }>();

function cacheKey(teamId: string, workspaceId?: string | null): string {
  return `${teamId}:${workspaceId ?? 'null'}`;
}

/** Flush the in-memory cache for a team (and optionally a specific workspace). */
export function invalidateTierCache(teamId: string, workspaceId?: string | null): void {
  // Always flush team-wide key
  cache.delete(cacheKey(teamId, null));
  // If a workspace is specified, flush that key too
  if (workspaceId) {
    cache.delete(cacheKey(teamId, workspaceId));
  }
}

/**
 * Resolve a tier from the live catalog when no registry row pins it — the
 * self-healing path. Null means "learned nothing" (empty/failed catalog, or
 * nothing in-band survives the capability filter): the caller falls back to
 * TIER_DEFAULTS rather than inventing a pick.
 *
 * `runnerCliVersion`, when supplied, excludes a candidate the claiming runner
 * cannot actually serve (its CLI predates the model's version floor) — the
 * newest-wins sort in `pickTierModel` then lands on the previous in-band
 * release instead of deferring the task entirely.
 */
async function resolveFromCatalog(
  tier: Tier,
  runnerCliVersion?: string | null,
): Promise<TierEntry | null> {
  try {
    const entries = await getCachedOpenRouterCatalog();
    if (entries.length === 0) return null;

    const pick = pickTierModel(tier, entries, 'anthropic', {
      isServable: (id) => checkModelClientCapability(id, runnerCliVersion).ok,
    });
    if (!pick) return null;

    return { provider: 'anthropic', model: pick.id, source: 'catalog' };
  } catch {
    return null;
  }
}

/**
 * Resolve the effective tier entry for a given team and optional workspace.
 * Returns the entry + source annotation ('workspace' | 'team' | 'catalog' | 'default').
 *
 * The returned entry is what gets passed to the runner as { model, provider, ... }.
 * For provider='openrouter', the backend implementation is out of scope but the
 * entry is stored and retrievable — dispatch throws a clear error if dispatched.
 *
 * `runnerCliVersion` (the claiming runner's reported CLI version) only affects
 * the catalog step — an explicit registry row is an operator's deliberate
 * choice and is never second-guessed by a client capability check.
 */
export async function resolveTierEntry(
  tier: Tier,
  teamId: string,
  workspaceId?: string | null,
  runnerCliVersion?: string | null,
): Promise<TierEntry> {
  const key = cacheKey(teamId, workspaceId);
  const now = Date.now();

  // Check cache
  const cached = cache.get(key);
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
    const entry = cached.entries.get(tier);
    if (entry) return entry;
  }

  try {
    // Fetch both workspace override and team default in one query
    const rows = await db.query.modelTierRegistry.findMany({
      where: and(
        eq(modelTierRegistry.teamId, teamId),
        eq(modelTierRegistry.tier, tier),
      ),
    });

    // Prefer workspace override over team default
    const workspaceRow = workspaceId
      ? rows.find(r => r.workspaceId === workspaceId)
      : undefined;
    const teamRow = rows.find(r => r.workspaceId === null);
    const row = workspaceRow ?? teamRow;

    if (row) {
      const entry: TierEntry = {
        provider: row.provider as TierProvider,
        model: row.model,
        source: workspaceRow ? 'workspace' : 'team',
        ...(row.defaultEffort ? { defaultEffort: row.defaultEffort as TierEntry['defaultEffort'] } : {}),
        ...(row.defaultMaxTurns != null ? { defaultMaxTurns: row.defaultMaxTurns } : {}),
      };

      // Update cache
      let cacheEntry = cache.get(key);
      if (!cacheEntry || now - cacheEntry.loadedAt >= CACHE_TTL_MS) {
        cacheEntry = { entries: new Map(), loadedAt: now };
        cache.set(key, cacheEntry);
      }
      cacheEntry.entries.set(tier, entry);
      return entry;
    }
  } catch {
    // DB unavailable — fall through to the catalog, then defaults.
  }

  // No explicit registry row (or the DB was unreachable): try the live
  // catalog before the hand-maintained default, so a new same-band release
  // (e.g. a cheaper Opus) is adopted without a deploy or a registry write.
  // Deliberately NOT cached in `cache` above — the pick can depend on the
  // claiming runner's CLI version, and `cache` is keyed by team:workspace
  // only, so caching it there would serve one runner's pick to another.
  // getCachedOpenRouterCatalog() already caches the expensive part (the
  // network fetch); pickTierModel is a cheap in-memory scan.
  const catalogEntry = await resolveFromCatalog(tier, runnerCliVersion);
  if (catalogEntry) return catalogEntry;

  return { ...TIER_DEFAULTS[tier] };
}

/**
 * Synchronous resolve using code-level defaults only.
 * Used in contexts where async isn't possible (e.g. runner config fallback).
 */
export function resolveTierEntrySync(tier: Tier): TierEntry {
  return { ...TIER_DEFAULTS[tier] };
}

/**
 * Return the effective tier map for a workspace (all three tiers resolved).
 * Used by manage_model_tiers list action.
 */
export async function resolveAllTiers(
  teamId: string,
  workspaceId?: string | null,
): Promise<Record<Tier, TierEntry>> {
  const entries = await Promise.all(
    TIERS.map((tier) => resolveTierEntry(tier, teamId, workspaceId)),
  );
  return Object.fromEntries(
    TIERS.map((tier, i) => [tier, entries[i]]),
  ) as Record<Tier, TierEntry>;
}

/**
 * Persisted cache for the public OpenRouter catalog (see `model-catalog.ts`).
 *
 * Claim-time tier resolution cannot afford a ~hundreds-of-KB network fetch on
 * every claim, and a Vercel serverless invocation has no warm process to hold
 * an in-memory cache across cold starts — so this persists into
 * `system_cache`, the same generic cache table `model-aliases.ts` uses, with
 * an in-process layer on top so a warm process serving many claims in a row
 * pays for the DB round trip at most once per TTL window.
 *
 * Read-through: a fresh row wins, a missing/expired/unreadable row falls
 * through to a direct fetch, and a successful fetch is written back so the
 * next cold start finds a warm row instead of hitting the network itself.
 */
import { db } from './db/client';
import { systemCache } from './db/schema';
import { eq } from 'drizzle-orm';
import { fetchOpenRouterCatalog, type CatalogEntry } from './model-catalog';

const CACHE_KEY = 'openrouter_catalog';
// Matches the TTL `/api/models` already uses for the same public list — model
// prices and lineups change on the order of months, not hours.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let memCache: { entries: CatalogEntry[]; loadedAt: number } | null = null;

/** Exposed for tests only — resets the in-process cache. */
export function _resetCatalogCache(): void {
  memCache = null;
}

/**
 * The public OpenRouter catalog, cached. Costs a network fetch at most once
 * per `CACHE_TTL_MS` per process, and — via the `system_cache` row — at most
 * once per `CACHE_TTL_MS` across every process, warm or cold.
 *
 * Never throws: DB and network failures both fall through to `[]`, matching
 * `fetchOpenRouterCatalog`'s own contract that an empty catalog means "we
 * learned nothing," which callers already handle.
 */
export async function getCachedOpenRouterCatalog(): Promise<CatalogEntry[]> {
  const now = Date.now();
  if (memCache && now - memCache.loadedAt < CACHE_TTL_MS) {
    return memCache.entries;
  }

  try {
    const row = await db.query.systemCache.findFirst({
      where: eq(systemCache.key, CACHE_KEY),
    });
    if (row && (!row.expiresAt || row.expiresAt.getTime() > now) && Array.isArray(row.value)) {
      const entries = row.value as CatalogEntry[];
      memCache = { entries, loadedAt: now };
      return entries;
    }
  } catch {
    // No row, no table, no DB — fall through to a direct fetch.
  }

  const entries = await fetchOpenRouterCatalog();
  if (entries.length > 0) {
    memCache = { entries, loadedAt: now };
    try {
      await db
        .insert(systemCache)
        .values({
          key: CACHE_KEY,
          value: entries,
          updatedAt: new Date(),
          expiresAt: new Date(now + CACHE_TTL_MS),
        })
        .onConflictDoUpdate({
          target: systemCache.key,
          set: {
            value: entries,
            updatedAt: new Date(),
            expiresAt: new Date(now + CACHE_TTL_MS),
          },
        });
    } catch {
      // Non-fatal — the entries are still returned; the next cold start just
      // re-fetches from the network instead of finding a warm row.
    }
  }
  return entries;
}

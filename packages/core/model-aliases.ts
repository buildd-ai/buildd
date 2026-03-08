/**
 * Model alias resolution — maps short names (haiku, sonnet, opus) to full model IDs.
 *
 * Reads from system_cache in DB (populated by runner's supportedModels() call).
 * Falls back to hardcoded defaults if cache is empty/expired.
 */
import { db } from './db/client';
import { systemCache } from './db/schema';
import { eq } from 'drizzle-orm';

const CACHE_KEY = 'model_aliases';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Hardcoded fallbacks — updated on new releases. */
const DEFAULT_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

/** In-memory cache to avoid DB reads on every call. */
let memoryCache: { aliases: Record<string, string>; loadedAt: number } | null = null;
const MEMORY_TTL_MS = 5 * 60 * 1000; // 5 min in-memory

/**
 * Resolve a short model name to a full model ID.
 * Returns the input unchanged if it's already a full ID.
 */
export async function resolveModelName(name: string): Promise<string> {
  const lower = name.toLowerCase();

  // Fast path: not a short alias
  if (!['haiku', 'sonnet', 'opus'].includes(lower)) return name;

  const aliases = await getAliases();
  return aliases[lower] || DEFAULT_ALIASES[lower] || name;
}

/**
 * Synchronous resolve using in-memory cache only.
 * Falls back to hardcoded defaults if cache is cold.
 */
export function resolveModelNameSync(name: string): string {
  const lower = name.toLowerCase();
  if (!['haiku', 'sonnet', 'opus'].includes(lower)) return name;

  if (memoryCache && Date.now() - memoryCache.loadedAt < MEMORY_TTL_MS) {
    return memoryCache.aliases[lower] || DEFAULT_ALIASES[lower] || name;
  }
  return DEFAULT_ALIASES[lower] || name;
}

async function getAliases(): Promise<Record<string, string>> {
  // Check in-memory cache first
  if (memoryCache && Date.now() - memoryCache.loadedAt < MEMORY_TTL_MS) {
    return memoryCache.aliases;
  }

  try {
    const row = await db.query.systemCache.findFirst({
      where: eq(systemCache.key, CACHE_KEY),
    });

    if (row && row.value && typeof row.value === 'object') {
      const isExpired = row.expiresAt && new Date(row.expiresAt) < new Date();
      if (!isExpired) {
        const aliases = row.value as Record<string, string>;
        memoryCache = { aliases, loadedAt: Date.now() };
        return aliases;
      }
    }
  } catch {
    // DB unavailable — fall through to defaults
  }

  return DEFAULT_ALIASES;
}

/**
 * Update the cached model aliases from a supportedModels() response.
 * Called by the runner after discovering model capabilities.
 */
export async function updateModelAliases(
  models: Array<{ value: string; label?: string }>
): Promise<void> {
  const aliases: Record<string, string> = {};

  for (const model of models) {
    const id = model.value.toLowerCase();
    if (id.includes('haiku')) aliases.haiku = model.value;
    if (id.includes('sonnet')) aliases.sonnet = model.value;
    if (id.includes('opus')) aliases.opus = model.value;
  }

  // Only write if we found at least one alias
  if (Object.keys(aliases).length === 0) return;

  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);

  try {
    await db
      .insert(systemCache)
      .values({
        key: CACHE_KEY,
        value: aliases,
        updatedAt: new Date(),
        expiresAt,
      })
      .onConflictDoUpdate({
        target: systemCache.key,
        set: {
          value: aliases,
          updatedAt: new Date(),
          expiresAt,
        },
      });

    // Update in-memory cache
    memoryCache = { aliases, loadedAt: Date.now() };
  } catch {
    // Non-fatal — next worker session will retry
  }
}

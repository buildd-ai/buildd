/**
 * Persistence for the platform tier default (model-tier-platform-default.ts).
 *
 * One `system_cache` row per tier, key `platform_tier_default:<tier>`, no
 * expiry: the same home as the other platform runtime records (the rerank
 * switch, model certifications), so no new table and no migration. Writes are
 * optimistic: an update or delete lands only while the row still holds the
 * value the caller read (neon-http has no interactive transactions), so two
 * admins cannot silently overwrite each other.
 *
 * Reads on the claim path go through a 60s in-process cache, like the team
 * registry, and fail open to "no platform default": a DB hiccup must never
 * change which model a claim gets, and the next layer (the catalog pick, then
 * the bundled fallback) is exactly what every team ran before this existed.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { systemCache } from './db/schema';
import type { Tier } from './model-tier-defaults';
import {
  PLATFORM_TIER_DEFAULT_KEY_PREFIX,
  parsePlatformTierDefault,
  platformTierDefaultKey,
  type PlatformTierDefault,
} from './model-tier-platform-default';
import { sqlWhere } from './db/relational-sql';

const CACHE_TTL_MS = 60 * 1000;

let memCache: { rows: Map<Tier, PlatformTierDefault>; loadedAt: number } | null = null;

/** Forget the cached rows. For tests and after a write in this process. */
export function invalidatePlatformTierDefaultCache(): void {
  memCache = null;
}

/** Every tier's platform default, cached for 60s per process. Never throws. */
export async function loadPlatformTierDefaults(): Promise<Map<Tier, PlatformTierDefault>> {
  const now = Date.now();
  if (memCache && now - memCache.loadedAt < CACHE_TTL_MS) return memCache.rows;
  try {
    const rows = await db
      .select({ key: systemCache.key, value: systemCache.value })
      .from(systemCache)
      .where(sql`${systemCache.key} LIKE ${PLATFORM_TIER_DEFAULT_KEY_PREFIX + '%'}`);
    const out = new Map<Tier, PlatformTierDefault>();
    for (const r of rows) {
      const parsed = parsePlatformTierDefault(r.value);
      if (parsed && r.key === platformTierDefaultKey(parsed.tier)) out.set(parsed.tier, parsed);
    }
    memCache = { rows: out, loadedAt: now };
    return out;
  } catch {
    return memCache?.rows ?? new Map();
  }
}

/** One tier's row as stored, past the cache (for the admin read path and before a write). */
export async function readPlatformTierDefault(tier: Tier): Promise<PlatformTierDefault | null> {
  const row = await db.query.systemCache.findFirst({ where: sqlWhere(eq(systemCache.key, platformTierDefaultKey(tier))) });
  return row ? parsePlatformTierDefault(row.value) : null;
}

/**
 * Replace `tier`'s row: insert when `prev` is null, else update or (with
 * `next` null) delete only while the row still holds `prev`. True when the
 * write landed; false means someone else changed it first and the caller
 * should re-read.
 */
export async function writePlatformTierDefault(
  tier: Tier,
  prev: PlatformTierDefault | null,
  next: PlatformTierDefault | null,
): Promise<boolean> {
  const key = platformTierDefaultKey(tier);
  const now = new Date();
  let landed: boolean;
  if (!prev) {
    if (!next) return true;
    const rows = await db
      .insert(systemCache)
      .values({ key, value: next, updatedAt: now, expiresAt: null })
      .onConflictDoNothing()
      .returning({ key: systemCache.key });
    landed = rows.length > 0;
  } else if (next) {
    const rows = await db
      .update(systemCache)
      .set({ value: next, updatedAt: now })
      .where(and(eq(systemCache.key, key), sql`${systemCache.value} = ${JSON.stringify(prev)}::jsonb`))
      .returning({ key: systemCache.key });
    landed = rows.length > 0;
  } else {
    const rows = await db
      .delete(systemCache)
      .where(and(eq(systemCache.key, key), sql`${systemCache.value} = ${JSON.stringify(prev)}::jsonb`))
      .returning({ key: systemCache.key });
    landed = rows.length > 0;
  }
  if (landed) invalidatePlatformTierDefaultCache();
  return landed;
}

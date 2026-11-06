/**
 * The platform switch for reranking with the platform's Voyage key.
 *
 * One `system_cache` row, key `platform_rerank_enabled`, value `{ "enabled": boolean }`.
 * It is a system-level runtime setting, not a credential, so it lives beside the
 * other runtime records (policy overrides) and not in `secrets`.
 *
 * Fail closed: a missing row, a value that is not exactly `{ enabled: true }`, or
 * a read that throws all resolve to OFF. Reads are cached per process for
 * `PLATFORM_RERANK_TTL_MS`; a write through `setPlatformRerankEnabled` clears the
 * cache in this process, and other processes pick the change up within the TTL.
 *
 * Only the reranker built from the platform key (`getVoyageReranker`) is gated.
 * A reranker built with its own key is not.
 */
import { sharedProcessState } from './runtime-snapshot';

// drizzle and the db load lazily: the Voyage guard imports this module, and
// test files that stub drizzle must not fail at import time.

export const PLATFORM_RERANK_KEY = 'platform_rerank_enabled';
export const PLATFORM_RERANK_TTL_MS = 60_000;

/** Pure: the switch is on only for a record that is exactly `{ enabled: true }`. */
export function parsePlatformRerankRecord(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return (raw as { enabled?: unknown }).enabled === true;
}

interface CacheState {
  loadedAt: number;
  value: boolean;
  inflight: Promise<boolean> | null;
}

const cache = (): CacheState => sharedProcessState<CacheState>(
  'buildd.platformRerankSwitch',
  () => ({ loadedAt: 0, value: false, inflight: null }),
);

async function readRecordFromDb(): Promise<unknown> {
  const { db } = await import('./db/index');
  const { systemCache } = await import('./db/schema');
  const { eq } = await import('drizzle-orm');
  const [row] = await db
    .select({ value: systemCache.value })
    .from(systemCache)
    .where(eq(systemCache.key, PLATFORM_RERANK_KEY))
    .limit(1);
  return row?.value;
}

export interface LoadPlatformRerankOptions {
  read?: () => Promise<unknown>;
  now?: () => number;
  force?: boolean;
}

/**
 * Whether reranking with the platform key is on right now. Never throws; any
 * failure to read is OFF.
 */
export function loadPlatformRerankEnabled(opts: LoadPlatformRerankOptions = {}): Promise<boolean> {
  const state = cache();
  const now = opts.now ?? Date.now;
  if (!opts.force && state.loadedAt > 0 && now() - state.loadedAt < PLATFORM_RERANK_TTL_MS) {
    return Promise.resolve(state.value);
  }
  if (state.inflight && !opts.force) return state.inflight;

  const read = opts.read ?? readRecordFromDb;
  state.loadedAt = now();
  const run = (async () => {
    try {
      state.value = parsePlatformRerankRecord(await read());
    } catch (err) {
      state.value = false;
      console.warn('[platform-rerank] could not read the switch; reranking with the platform key is off:',
        err instanceof Error ? err.message : err);
    }
    return state.value;
  })();
  state.inflight = run;
  return run.finally(() => {
    if (state.inflight === run) state.inflight = null;
  });
}

/** The switch row as stored, read past the cache (for the admin read path and audit). */
export async function readPlatformRerankRow(): Promise<{ enabled: boolean } | null> {
  const raw = await readRecordFromDb();
  if (raw === undefined || raw === null) return null;
  return { enabled: parsePlatformRerankRecord(raw) };
}

/**
 * Set the switch and return the value it held before. Clears this process's
 * cache so the change is visible here at once.
 */
export async function setPlatformRerankEnabled(enabled: boolean): Promise<{ before: boolean; after: boolean }> {
  const before = (await readPlatformRerankRow())?.enabled ?? false;
  const { db } = await import('./db/index');
  const { systemCache } = await import('./db/schema');
  await db
    .insert(systemCache)
    .values({ key: PLATFORM_RERANK_KEY, value: { enabled }, updatedAt: new Date(), expiresAt: null })
    .onConflictDoUpdate({
      target: systemCache.key,
      set: { value: { enabled }, updatedAt: new Date(), expiresAt: null },
    });
  resetPlatformRerankCache();
  return { before, after: enabled };
}

/** Forget the cached value. For tests and after a write. */
export function resetPlatformRerankCache(): void {
  const state = cache();
  state.loadedAt = 0;
  state.value = false;
  state.inflight = null;
}

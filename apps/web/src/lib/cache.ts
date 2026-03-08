/**
 * In-memory TTL cache with LRU eviction.
 *
 * Used to cache frequently-read, rarely-changing data like API key → account
 * lookups and account → workspace permission mappings.
 *
 * Designed for Vercel's serverless environment:
 * - Each serverless instance gets its own cache (no cross-instance sharing)
 * - Cache is cold on cold start (gracefully falls back to DB)
 * - TTL ensures stale data is bounded even without explicit invalidation
 * - Max size prevents unbounded memory growth
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(opts: { maxSize: number; ttlMs: number }) {
    this.maxSize = opts.maxSize;
    this.ttlMs = opts.ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end for LRU ordering (Map preserves insertion order)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  set(key: string, value: T): void {
    // Delete first so re-insertion moves to end
    this.cache.delete(key);

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Delete a specific key. */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /** Delete all keys matching a predicate. */
  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of this.cache.keys()) {
      if (predicate(key)) {
        this.cache.delete(key);
      }
    }
  }

  /** Remove all entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Current number of entries (including expired that haven't been evicted). */
  get size(): number {
    return this.cache.size;
  }
}

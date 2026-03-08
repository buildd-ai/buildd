import { describe, it, expect, beforeEach } from 'bun:test';
import { TTLCache } from './cache';

describe('TTLCache', () => {
  let cache: TTLCache<string>;

  beforeEach(() => {
    cache = new TTLCache<string>({ maxSize: 3, ttlMs: 1000 });
  });

  describe('get/set', () => {
    it('returns undefined for missing keys', () => {
      expect(cache.get('missing')).toBeUndefined();
    });

    it('stores and retrieves values', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('overwrites existing values', () => {
      cache.set('key1', 'old');
      cache.set('key1', 'new');
      expect(cache.get('key1')).toBe('new');
    });
  });

  describe('TTL expiration', () => {
    it('returns undefined for expired entries', async () => {
      const shortCache = new TTLCache<string>({ maxSize: 10, ttlMs: 50 });
      shortCache.set('key1', 'value1');
      expect(shortCache.get('key1')).toBe('value1');

      await new Promise((r) => setTimeout(r, 60));
      expect(shortCache.get('key1')).toBeUndefined();
    });

    it('does not return expired entries even if present in map', async () => {
      const shortCache = new TTLCache<string>({ maxSize: 10, ttlMs: 10 });
      shortCache.set('a', 'val');
      await new Promise((r) => setTimeout(r, 20));
      // Internal map still has it, but get should not return it
      expect(shortCache.get('a')).toBeUndefined();
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest entry when at capacity', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('c', '3');
      // At capacity (3), adding d should evict a
      cache.set('d', '4');

      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe('2');
      expect(cache.get('c')).toBe('3');
      expect(cache.get('d')).toBe('4');
    });

    it('accessing a key refreshes its LRU position', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('c', '3');

      // Access 'a' to move it to the end
      cache.get('a');

      // Now 'b' should be the oldest
      cache.set('d', '4');
      expect(cache.get('a')).toBe('1');
      expect(cache.get('b')).toBeUndefined(); // evicted
      expect(cache.get('c')).toBe('3');
      expect(cache.get('d')).toBe('4');
    });

    it('overwriting a key refreshes its LRU position', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('c', '3');

      // Overwrite 'a' to refresh it
      cache.set('a', 'updated');

      // Now 'b' should be the oldest
      cache.set('d', '4');
      expect(cache.get('a')).toBe('updated');
      expect(cache.get('b')).toBeUndefined(); // evicted
    });
  });

  describe('delete', () => {
    it('removes a specific key', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.delete('a');
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe('2');
    });

    it('is a no-op for missing keys', () => {
      cache.delete('nonexistent');
      expect(cache.size).toBe(0);
    });
  });

  describe('deleteWhere', () => {
    it('removes entries matching a predicate', () => {
      cache.set('user:1', 'alice');
      cache.set('user:2', 'bob');
      cache.set('team:1', 'teamA');

      cache.deleteWhere((key) => key.startsWith('user:'));

      expect(cache.get('user:1')).toBeUndefined();
      expect(cache.get('user:2')).toBeUndefined();
      expect(cache.get('team:1')).toBe('teamA');
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
    });
  });

  describe('size', () => {
    it('tracks the number of entries', () => {
      expect(cache.size).toBe(0);
      cache.set('a', '1');
      expect(cache.size).toBe(1);
      cache.set('b', '2');
      expect(cache.size).toBe(2);
      cache.delete('a');
      expect(cache.size).toBe(1);
    });

    it('does not grow beyond maxSize', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('c', '3');
      cache.set('d', '4');
      cache.set('e', '5');
      expect(cache.size).toBeLessThanOrEqual(3);
    });
  });
});

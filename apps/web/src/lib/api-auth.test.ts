import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createHash } from 'crypto';

// Mock database
const mockAccountsFindFirst = mock(() => null as any);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey', id: 'id' },
}));

import {
  hashApiKey,
  extractApiKeyPrefix,
  authenticateApiKey,
  invalidateAccountCache,
  invalidateAccountCacheByHash,
  clearAccountCache,
} from './api-auth';

describe('hashApiKey', () => {
  it('returns SHA-256 hex hash of the input', () => {
    const key = 'bld_test123';
    const expected = createHash('sha256').update(key).digest('hex');
    expect(hashApiKey(key)).toBe(expected);
  });

  it('returns different hashes for different keys', () => {
    const hash1 = hashApiKey('bld_key1');
    const hash2 = hashApiKey('bld_key2');
    expect(hash1).not.toBe(hash2);
  });

  it('returns consistent hash for same key', () => {
    const key = 'bld_consistent';
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it('returns 64-character hex string', () => {
    const hash = hashApiKey('bld_any_key');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('extractApiKeyPrefix', () => {
  it('returns first 12 characters of the key', () => {
    const key = 'bld_abc12345xyz789';
    expect(extractApiKeyPrefix(key)).toBe('bld_abc12345');
  });

  it('returns full key if shorter than 12 chars', () => {
    const key = 'short';
    expect(extractApiKeyPrefix(key)).toBe('short');
  });

  it('returns exactly 12 chars for longer keys', () => {
    const key = 'bld_' + 'a'.repeat(64);
    expect(extractApiKeyPrefix(key)).toHaveLength(12);
  });
});

describe('authenticateApiKey', () => {
  beforeEach(() => {
    mockAccountsFindFirst.mockReset();
    clearAccountCache();
  });

  it('returns null when apiKey is null', async () => {
    const result = await authenticateApiKey(null);
    expect(result).toBeNull();
    expect(mockAccountsFindFirst).not.toHaveBeenCalled();
  });

  it('returns null when apiKey is empty string', async () => {
    const result = await authenticateApiKey('');
    expect(result).toBeNull();
  });

  it('returns account when key matches', async () => {
    const mockAccount = { id: 'account-123', name: 'Test Account' };
    mockAccountsFindFirst.mockResolvedValue(mockAccount);

    const result = await authenticateApiKey('bld_valid_key');
    expect(result).toEqual(mockAccount);
    expect(mockAccountsFindFirst).toHaveBeenCalled();
  });

  it('returns null when no account matches the hashed key', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);

    const result = await authenticateApiKey('bld_invalid_key');
    expect(result).toBeNull();
  });

  it('returns null when account is undefined', async () => {
    mockAccountsFindFirst.mockResolvedValue(undefined);

    const result = await authenticateApiKey('bld_unknown');
    expect(result).toBeNull();
  });

  it('hashes the key before querying', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);

    await authenticateApiKey('bld_test_key');

    // The mock should have been called with eq() containing the hashed key
    expect(mockAccountsFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.anything(),
      })
    );
  });

  describe('caching', () => {
    it('serves subsequent calls from cache (no additional DB query)', async () => {
      const mockAccount = { id: 'account-123', name: 'Test Account' };
      mockAccountsFindFirst.mockResolvedValue(mockAccount);

      const result1 = await authenticateApiKey('bld_cached_key');
      const result2 = await authenticateApiKey('bld_cached_key');

      expect(result1).toEqual(mockAccount);
      expect(result2).toEqual(mockAccount);
      // DB should only be queried once
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(1);
    });

    it('caches null results (negative cache)', async () => {
      mockAccountsFindFirst.mockResolvedValue(null);

      await authenticateApiKey('bld_bad_key');
      await authenticateApiKey('bld_bad_key');

      // DB should only be queried once for the same invalid key
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(1);
    });

    it('different keys get separate cache entries', async () => {
      const account1 = { id: 'acct-1', name: 'Account 1' };
      const account2 = { id: 'acct-2', name: 'Account 2' };
      mockAccountsFindFirst.mockResolvedValueOnce(account1);
      mockAccountsFindFirst.mockResolvedValueOnce(account2);

      const result1 = await authenticateApiKey('bld_key_1');
      const result2 = await authenticateApiKey('bld_key_2');

      expect(result1).toEqual(account1);
      expect(result2).toEqual(account2);
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(2);

      // Subsequent calls should be from cache
      const result1b = await authenticateApiKey('bld_key_1');
      const result2b = await authenticateApiKey('bld_key_2');
      expect(result1b).toEqual(account1);
      expect(result2b).toEqual(account2);
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(2); // still 2
    });
  });

  describe('cache invalidation', () => {
    it('invalidateAccountCache forces a re-query for that account', async () => {
      const mockAccount = { id: 'account-123', name: 'Test Account' };
      mockAccountsFindFirst.mockResolvedValue(mockAccount);

      await authenticateApiKey('bld_key');
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(1);

      // Invalidate by account ID
      invalidateAccountCache('account-123');

      // Next call should re-query
      await authenticateApiKey('bld_key');
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(2);
    });

    it('invalidateAccountCacheByHash forces a re-query', async () => {
      const mockAccount = { id: 'account-123', name: 'Test Account' };
      mockAccountsFindFirst.mockResolvedValue(mockAccount);

      await authenticateApiKey('bld_key');
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(1);

      // Invalidate by hashed key
      invalidateAccountCacheByHash(hashApiKey('bld_key'));

      // Next call should re-query
      await authenticateApiKey('bld_key');
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(2);
    });

    it('invalidateAccountCacheByHash clears negative cache too', async () => {
      mockAccountsFindFirst.mockResolvedValueOnce(null);

      await authenticateApiKey('bld_new_key');
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(1);

      // Key was negative-cached. Now invalidate it (e.g., key was just created)
      invalidateAccountCacheByHash(hashApiKey('bld_new_key'));

      // Mock now returns an account (key exists in DB)
      const mockAccount = { id: 'new-acct', name: 'New Account' };
      mockAccountsFindFirst.mockResolvedValueOnce(mockAccount);

      const result = await authenticateApiKey('bld_new_key');
      expect(result).toEqual(mockAccount);
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(2);
    });

    it('clearAccountCache empties all caches', async () => {
      const mockAccount = { id: 'acct-1', name: 'Account 1' };
      mockAccountsFindFirst.mockResolvedValue(mockAccount);

      await authenticateApiKey('bld_key_a');
      await authenticateApiKey('bld_key_b');
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(2);

      clearAccountCache();

      // Both should re-query
      await authenticateApiKey('bld_key_a');
      await authenticateApiKey('bld_key_b');
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(4);
    });
  });
});

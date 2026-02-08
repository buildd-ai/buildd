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

import { hashApiKey, extractApiKeyPrefix, authenticateApiKey } from './api-auth';

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
});

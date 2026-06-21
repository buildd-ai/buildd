/**
 * Unit tests for the in-memory per-team server credential cache and the
 * auth-failure exponential backoff helper.
 *
 * These guard the "runner with zero local creds" path: the cache must serve a
 * fresh server-delivered credential, refresh on TTL expiry, and invalidate on
 * a 401 so a rotated/fixed credential is picked up promptly.
 */

import { describe, test, expect } from 'bun:test';
import {
  CredentialCache,
  authBackoffMs,
  DEFAULT_SERVER_CRED_TTL_MS,
} from '../../src/credential-cache';

describe('CredentialCache', () => {
  test('returns a fresh credential set from a claim payload', () => {
    const cache = new CredentialCache();
    const now = 1_000_000;
    cache.set('team_a', { oauthToken: 'oauth-1' }, now);
    const got = cache.get('team_a', now + 1000);
    expect(got?.oauthToken).toBe('oauth-1');
    expect(cache.has('team_a', now + 1000)).toBe(true);
  });

  test('keeps credentials isolated per team', () => {
    const cache = new CredentialCache();
    const now = 1_000_000;
    cache.set('team_a', { apiKey: 'key-a' }, now);
    cache.set('team_b', { oauthToken: 'oauth-b' }, now);
    expect(cache.get('team_a', now)?.apiKey).toBe('key-a');
    expect(cache.get('team_a', now)?.oauthToken).toBeUndefined();
    expect(cache.get('team_b', now)?.oauthToken).toBe('oauth-b');
  });

  test('treats an entry older than the TTL as stale (refresh on next claim)', () => {
    const cache = new CredentialCache(1000); // 1s TTL
    const now = 5_000_000;
    cache.set('team_a', { oauthToken: 'oauth-1' }, now);
    expect(cache.get('team_a', now + 999)?.oauthToken).toBe('oauth-1');
    // At/after TTL it is stale and dropped.
    expect(cache.get('team_a', now + 1000)).toBeUndefined();
    expect(cache.has('team_a', now + 1000)).toBe(false);
    // A later claim repopulates it.
    cache.set('team_a', { oauthToken: 'oauth-2' }, now + 2000);
    expect(cache.get('team_a', now + 2000)?.oauthToken).toBe('oauth-2');
  });

  test('invalidate drops the entry on a 401 so a rotated cred is re-fetched', () => {
    const cache = new CredentialCache();
    const now = 1_000_000;
    cache.set('team_a', { oauthToken: 'bad-token' }, now);
    expect(cache.get('team_a', now)?.oauthToken).toBe('bad-token');
    cache.invalidate('team_a');
    expect(cache.get('team_a', now)).toBeUndefined();
    // Next claim delivers the fixed credential.
    cache.set('team_a', { oauthToken: 'good-token' }, now + 10);
    expect(cache.get('team_a', now + 10)?.oauthToken).toBe('good-token');
  });

  test('ignores empty credentials and empty team ids', () => {
    const cache = new CredentialCache();
    cache.set('team_a', {});
    expect(cache.has('team_a')).toBe(false);
    cache.set('', { oauthToken: 'x' });
    expect(cache.has('')).toBe(false);
    expect(cache.get('')).toBeUndefined();
  });

  test('default TTL is ~3h', () => {
    const cache = new CredentialCache();
    expect(cache.ttl).toBe(DEFAULT_SERVER_CRED_TTL_MS);
    expect(DEFAULT_SERVER_CRED_TTL_MS).toBe(3 * 60 * 60 * 1000);
  });
});

describe('authBackoffMs', () => {
  test('doubles each consecutive failure from the base', () => {
    expect(authBackoffMs(1, { baseMs: 1000, maxMs: 1_000_000 })).toBe(1000);
    expect(authBackoffMs(2, { baseMs: 1000, maxMs: 1_000_000 })).toBe(2000);
    expect(authBackoffMs(3, { baseMs: 1000, maxMs: 1_000_000 })).toBe(4000);
    expect(authBackoffMs(4, { baseMs: 1000, maxMs: 1_000_000 })).toBe(8000);
  });

  test('caps at maxMs', () => {
    expect(authBackoffMs(20, { baseMs: 1000, maxMs: 5000 })).toBe(5000);
  });

  test('returns 0 for a non-positive failure count', () => {
    expect(authBackoffMs(0)).toBe(0);
    expect(authBackoffMs(-3)).toBe(0);
  });

  test('uses sane defaults (1 min base, 30 min cap)', () => {
    expect(authBackoffMs(1)).toBe(60 * 1000);
    expect(authBackoffMs(2)).toBe(2 * 60 * 1000);
    expect(authBackoffMs(99)).toBe(30 * 60 * 1000);
  });
});

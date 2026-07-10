import { describe, it, expect } from 'bun:test';
import { resolveRedisConfig } from './redis';

describe('resolveRedisConfig', () => {
  it('reports "none" when nothing is configured', () => {
    const c = resolveRedisConfig({});
    expect(c.status).toBe('none');
    expect(c.url).toBeUndefined();
    expect(c.host).toBeNull();
  });

  it('resolves the Upstash-native pair and extracts the host', () => {
    const c = resolveRedisConfig({
      UPSTASH_REDIS_REST_URL: 'https://select-osprey-161914.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'tok_osprey',
    });
    expect(c.status).toBe('ok');
    expect(c.url).toBe('https://select-osprey-161914.upstash.io');
    expect(c.token).toBe('tok_osprey');
    expect(c.host).toBe('select-osprey-161914.upstash.io');
  });

  it('prefers KV_REST_API_* over UPSTASH_REDIS_REST_* (Vercel-KV precedence)', () => {
    const c = resolveRedisConfig({
      KV_REST_API_URL: 'https://kv-db.upstash.io',
      KV_REST_API_TOKEN: 'tok_kv',
      UPSTASH_REDIS_REST_URL: 'https://osprey.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'tok_osprey',
    });
    expect(c.host).toBe('kv-db.upstash.io');
    expect(c.token).toBe('tok_kv');
  });

  // Regression for the 2026-07 incident: KV_REST_API_URL pointed at a dead DB
  // (careful-cat) while the token was stored under the WRONG name (KV_REST_TOKEN,
  // not KV_REST_API_TOKEN). So url resolved to the dead DB but token fell through
  // to the OTHER DB's token — a crossed pair that authenticates against nothing.
  // The resolver must surface the host it will actually hit so this is visible.
  it('flags a crossed pair by reporting the (wrong) host it would connect to', () => {
    const c = resolveRedisConfig({
      KV_REST_API_URL: 'https://careful-cat-49924.upstash.io', // dead DB
      KV_REST_TOKEN: 'tok_kv_wrong_name', // NOT read — wrong var name
      UPSTASH_REDIS_REST_URL: 'https://select-osprey-161914.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'tok_osprey', // token that gets paired instead
    });
    // url = careful-cat, token = osprey's → crossed, but status still "ok".
    // The host readout is what makes the mismatch diagnosable in logs.
    expect(c.status).toBe('ok');
    expect(c.host).toBe('careful-cat-49924.upstash.io');
    expect(c.token).toBe('tok_osprey');
  });

  it('reports "partial" when only a URL is present (no usable token)', () => {
    const c = resolveRedisConfig({ UPSTASH_REDIS_REST_URL: 'https://osprey.upstash.io' });
    expect(c.status).toBe('partial');
    expect(c.host).toBe('osprey.upstash.io');
  });

  it('reports "partial" when only a token is present', () => {
    const c = resolveRedisConfig({ UPSTASH_REDIS_REST_TOKEN: 'tok_only' });
    expect(c.status).toBe('partial');
    expect(c.host).toBeNull();
  });
});

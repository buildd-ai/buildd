import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  parsePlatformRerankRecord,
  loadPlatformRerankEnabled,
  resetPlatformRerankCache,
} from '../platform-rerank-switch';
import { createVoyageGuard, type VoyageGuardDeps, type VoyageRequest } from '../knowledge-store/voyage-guard';

describe('parsePlatformRerankRecord', () => {
  it('is off when there is no record', () => {
    expect(parsePlatformRerankRecord(undefined)).toBe(false);
    expect(parsePlatformRerankRecord(null)).toBe(false);
  });

  it('is on only for an explicit { enabled: true }', () => {
    expect(parsePlatformRerankRecord({ enabled: true })).toBe(true);
  });

  it('is off for anything else (fail closed)', () => {
    expect(parsePlatformRerankRecord({ enabled: false })).toBe(false);
    expect(parsePlatformRerankRecord({ enabled: 'true' })).toBe(false);
    expect(parsePlatformRerankRecord({ enabled: 1 })).toBe(false);
    expect(parsePlatformRerankRecord({})).toBe(false);
    expect(parsePlatformRerankRecord(true)).toBe(false);
    expect(parsePlatformRerankRecord('enabled')).toBe(false);
    expect(parsePlatformRerankRecord([{ enabled: true }])).toBe(false);
  });
});

describe('loadPlatformRerankEnabled', () => {
  beforeEach(() => resetPlatformRerankCache());
  afterEach(() => resetPlatformRerankCache());

  it('defaults to off when the record is missing', async () => {
    expect(await loadPlatformRerankEnabled({ read: async () => undefined, now: () => 0 })).toBe(false);
  });

  it('reads on when the record says enabled', async () => {
    expect(await loadPlatformRerankEnabled({ read: async () => ({ enabled: true }), now: () => 0 })).toBe(true);
  });

  it('treats an unreadable setting as off, even after it was on', async () => {
    let t = 0;
    const now = () => t;
    expect(await loadPlatformRerankEnabled({ read: async () => ({ enabled: true }), now })).toBe(true);
    t = 120_000; // past the TTL, so the next read happens
    expect(await loadPlatformRerankEnabled({
      read: async () => { throw new Error('db down'); },
      now,
    })).toBe(false);
  });

  it('caches within the TTL and rereads after it', async () => {
    let t = 0;
    let reads = 0;
    const now = () => t;
    const read = async () => { reads++; return { enabled: reads > 1 }; };
    t = 1_000_000;
    expect(await loadPlatformRerankEnabled({ read, now })).toBe(false);
    t = 1_001_000;
    expect(await loadPlatformRerankEnabled({ read, now })).toBe(false);
    expect(reads).toBe(1);
    t = 1_000_000 + 120_000;
    expect(await loadPlatformRerankEnabled({ read, now })).toBe(true);
    expect(reads).toBe(2);
  });
});

describe('platform switch in the Voyage guard', () => {
  const rerank: VoyageRequest = {
    namespace: 'ws-1:memory', caller: 'recall', kind: 'rerank', model: 'rerank-2.5', estimatedTokens: 100,
  };
  const embed: VoyageRequest = { ...rerank, kind: 'embed', model: 'voyage-4-large', inputType: 'document' };

  function guard(over: Partial<VoyageGuardDeps> = {}) {
    const reserved: number[] = [];
    const deps: VoyageGuardDeps = {
      env: {},
      now: () => new Date('2026-11-05T00:00:00Z'),
      resolveTeam: async () => ({ teamId: 'team-1', plan: 'pro' }),
      resolveOwnKey: async () => null,
      reserve: async r => { reserved.push(r.tokens); return true; },
      settle: async () => {},
      markDenied: async () => {},
      trace: () => {},
      platformRerankOn: async () => false,
      ...over,
    };
    return { g: createVoyageGuard(deps), reserved };
  }

  it('default off: a platform-key rerank is denied (null), with no reservation', async () => {
    const { g, reserved } = guard();
    expect(await g.admit(rerank)).toBeNull();
    expect(reserved).toHaveLength(0);
  });

  it('on: a platform-key rerank is admitted on the platform key', async () => {
    const { g } = guard({ platformRerankOn: async () => true });
    const permit = await g.admit(rerank);
    expect(permit).not.toBeNull();
    expect(permit?.apiKey).toBeUndefined();
  });

  it('embeds are unaffected by the switch', async () => {
    const { g } = guard({ platformRerankOn: async () => false });
    expect(await g.admit(embed)).not.toBeNull();
  });

  it("a team's own key is unaffected by the switch", async () => {
    const { g } = guard({ platformRerankOn: async () => false, resolveOwnKey: async () => 'team-own-key' });
    const permit = await g.admit(rerank);
    expect(permit?.apiKey).toBe('team-own-key');
  });

  it('a rerank whose team cannot be resolved is denied while off', async () => {
    const { g } = guard({ resolveTeam: async () => null, env: { VOYAGE_BUDGET_ENFORCED: '0' } });
    expect(await g.admit(rerank)).toBeNull();
  });

  it('fails closed when reading the switch throws', async () => {
    const { g } = guard({ platformRerankOn: async () => { throw new Error('unreadable'); } });
    expect(await g.admit(rerank)).toBeNull();
  });
});

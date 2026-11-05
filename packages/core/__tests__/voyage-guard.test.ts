import { describe, expect, it } from 'bun:test';
import { createVoyageGuard, type VoyageGuardDeps, type VoyageRequest } from '../knowledge-store/voyage-guard';
import { PAID_VOYAGE_EMBED_TOKENS } from '../voyage-budget';

const ON = { VOYAGE_BUDGET_ENFORCED: '1' };

const req = (over: Partial<VoyageRequest> = {}): VoyageRequest => ({
  namespace: 'ws-1:code',
  caller: 'test',
  kind: 'embed',
  model: 'voyage-code-3',
  estimatedTokens: 100,
  inputType: 'document',
  ...over,
});

function harness(over: Partial<VoyageGuardDeps> = {}) {
  const calls = {
    reserve: [] as Array<{ teamId: string; kind: string; tokens: number; cap: number | null }>,
    settle: [] as Array<{ delta: number; tokens: number; corpus: string; caller: string; model: string; teamId: string; keySource: string }>,
    denied: [] as string[],
    traced: [] as Array<Record<string, unknown>>,
  };
  const deps: VoyageGuardDeps = {
    env: ON,
    now: () => new Date('2026-11-05T00:00:00Z'),
    resolveTeam: async () => ({ teamId: 'team-1', plan: 'pro' }),
    resolveOwnKey: async () => null,
    reserve: async r => { calls.reserve.push(r); return true; },
    settle: async s => { calls.settle.push(s); },
    markDenied: async d => { calls.denied.push(d.kind); },
    trace: t => { calls.traced.push(t as unknown as Record<string, unknown>); },
    ...over,
  };
  return { guard: createVoyageGuard(deps), calls };
}

const FREE = { resolveTeam: async () => ({ teamId: 'team-1', plan: 'free' }) };

describe('voyage guard: paid plan within its allowance', () => {
  it('reserves against the fair-use allowance, on the platform key', async () => {
    const { guard, calls } = harness();
    const permit = await guard.admit(req());
    expect(permit?.apiKey).toBeUndefined();
    expect(calls.reserve[0]).toMatchObject({ teamId: 'team-1', kind: 'embed', tokens: 100, cap: PAID_VOYAGE_EMBED_TOKENS });
  });

  it('replaces the estimate with real usage, tagged for attribution', async () => {
    const { guard, calls } = harness();
    (await guard.admit(req({ caller: 'recall' })))!.settle(40);
    await Promise.resolve();
    expect(calls.settle[0]).toMatchObject({
      teamId: 'team-1', delta: -60, tokens: 40, corpus: 'code', caller: 'recall', model: 'voyage-code-3', keySource: 'platform',
    });
    expect(calls.traced[0]).toMatchObject({ teamId: 'team-1', corpus: 'code', caller: 'recall', model: 'voyage-code-3', tokens: 40, keySource: 'platform', outcome: 'ok' });
  });

  it('refunds the whole reservation when the call failed', async () => {
    const { guard, calls } = harness();
    (await guard.admit(req()))!.settle(0);
    await Promise.resolve();
    expect(calls.settle[0]).toMatchObject({ delta: -100, tokens: 0 });
  });

  it('never lets a settle failure reach the caller', async () => {
    const { guard } = harness({ settle: async () => { throw new Error('db down'); } });
    const permit = await guard.admit(req());
    expect(() => permit!.settle(10)).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
  });
});

describe('voyage guard: paid plan over its allowance', () => {
  it('denies, and records the denial', async () => {
    const { guard, calls } = harness({ reserve: async () => false });
    expect(await guard.admit(req())).toBeNull();
    expect(calls.denied).toEqual(['embed']);
    expect(calls.traced[0]).toMatchObject({ outcome: 'denied', corpus: 'code' });
  });

  it('applies to rerank the same way', async () => {
    const { guard, calls } = harness({ reserve: async () => false });
    expect(await guard.admit(req({ kind: 'rerank', model: 'rerank-2.5', inputType: undefined }))).toBeNull();
    expect(calls.denied).toEqual(['rerank']);
  });

  it('denies a single call bigger than the whole allowance without touching the counter', async () => {
    const { guard, calls } = harness();
    expect(await guard.admit(req({ estimatedTokens: PAID_VOYAGE_EMBED_TOKENS + 1 }))).toBeNull();
    expect(calls.reserve).toEqual([]);
  });

  it('gives query embeddings a higher ceiling than documents', async () => {
    const { guard, calls } = harness();
    await guard.admit(req({ inputType: 'query' }));
    expect(calls.reserve[0].cap!).toBeGreaterThan(PAID_VOYAGE_EMBED_TOKENS);
  });
});

describe('voyage guard: free plan', () => {
  it('makes no platform-key call for embed, rerank or query', async () => {
    const { guard } = harness(FREE);
    expect(await guard.admit(req())).toBeNull();
    expect(await guard.admit(req({ inputType: 'query' }))).toBeNull();
    expect(await guard.admit(req({ kind: 'rerank', model: 'rerank-2.5', inputType: undefined }))).toBeNull();
  });

  it('writes nothing for what is its normal state', async () => {
    const { guard, calls } = harness(FREE);
    await guard.admit(req());
    expect(calls.reserve).toEqual([]);
    expect(calls.denied).toEqual([]);
    expect(calls.traced[0]).toMatchObject({ outcome: 'denied', keySource: 'platform' });
  });
});

describe('voyage guard: the team\'s own key', () => {
  const OWN = { resolveOwnKey: async () => 'team-key' };

  it('runs a free team on its own key', async () => {
    const { guard } = harness({ ...FREE, ...OWN });
    expect((await guard.admit(req()))?.apiKey).toBe('team-key');
  });

  it('runs rerank on it too', async () => {
    const { guard } = harness({ ...FREE, ...OWN });
    expect((await guard.admit(req({ kind: 'rerank', model: 'rerank-2.5', inputType: undefined })))?.apiKey).toBe('team-key');
  });

  it('wins over the platform allowance on a paid plan', async () => {
    const { guard, calls } = harness(OWN);
    expect((await guard.admit(req()))?.apiKey).toBe('team-key');
    expect(calls.reserve).toEqual([]);
  });

  it('records usage as byok and leaves the allowance alone', async () => {
    const { guard, calls } = harness({ ...FREE, ...OWN });
    (await guard.admit(req()))!.settle(40);
    await Promise.resolve();
    expect(calls.settle[0]).toMatchObject({ keySource: 'byok', tokens: 40, delta: 0 });
    expect(calls.traced[0]).toMatchObject({ keySource: 'byok', outcome: 'ok' });
  });

  it('counts an unreadable key as no key: free stops, paid stays on the platform', async () => {
    const broken = { resolveOwnKey: async () => { throw new Error('decrypt failed'); } };
    expect(await harness({ ...FREE, ...broken }).guard.admit(req())).toBeNull();
    const paid = await harness(broken).guard.admit(req());
    expect(paid).not.toBeNull();
    expect(paid?.apiKey).toBeUndefined();
  });
});

describe('voyage guard: failing closed', () => {
  const lookupFails = async () => { throw new Error('neon blip'); };

  it('makes no platform call when the plan lookup fails', async () => {
    const { guard } = harness({ resolveTeam: lookupFails });
    expect(await guard.admit(req())).toBeNull();
  });

  it('makes no platform call when the namespace owner matches no team', async () => {
    const { guard } = harness({ resolveTeam: async () => null });
    expect(await guard.admit(req())).toBeNull();
  });

  it('does not fall back to an expired plan, even a paid one', async () => {
    let fail = false;
    let now = new Date('2026-11-05T00:00:00Z');
    const { guard } = harness({
      now: () => now,
      resolveTeam: async () => {
        if (fail) throw new Error('neon blip');
        return { teamId: 'team-1', plan: 'pro' };
      },
    });
    expect(await guard.admit(req())).not.toBeNull();
    fail = true;
    now = new Date('2026-11-05T01:00:00Z');
    expect(await guard.admit(req())).toBeNull();
  });

  it('a known paid plan proceeds when only the counter write fails', async () => {
    const { guard } = harness({ reserve: async () => { throw new Error('neon blip'); } });
    expect(await guard.admit(req())).not.toBeNull();
  });
});

describe('voyage guard: metering without enforcement', () => {
  it('passes a null cap, so nothing is refused', async () => {
    const { guard, calls } = harness({ env: {} });
    expect(await guard.admit(req())).not.toBeNull();
    expect(calls.reserve[0].cap).toBeNull();
  });

  it('lets a free team through on the platform key', async () => {
    const { guard } = harness({ ...FREE, env: {} });
    expect(await guard.admit(req())).not.toBeNull();
  });

  it('lets the call through when lookup fails', async () => {
    const { guard } = harness({ env: {}, resolveTeam: async () => { throw new Error('x'); } });
    const permit = await guard.admit(req());
    expect(permit).not.toBeNull();
    expect(() => permit!.settle(5)).not.toThrow();
  });

  it('keeps an exempt team metered and uncapped', async () => {
    const { guard, calls } = harness({ ...FREE, env: { ...ON, VOYAGE_BUDGET_EXEMPT_TEAMS: 'team-1' } });
    expect(await guard.admit(req())).not.toBeNull();
    expect(calls.reserve[0].cap).toBeNull();
  });
});

describe('voyage guard: team resolution is cached', () => {
  it('looks a namespace owner up once inside the TTL', async () => {
    let lookups = 0;
    const { guard } = harness({ resolveTeam: async () => { lookups++; return { teamId: 'team-1', plan: 'pro' }; } });
    await guard.admit(req());
    await guard.admit(req({ namespace: 'ws-1:docs' }));
    expect(lookups).toBe(1);
  });
});

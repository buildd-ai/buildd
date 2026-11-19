import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resolveTeamWallFallback, resolveWallFallbackCredential, wallFallbackSpentToday, type WallFallbackDeps } from './provider-wall-fallback';

const route = (over: Record<string, unknown> = {}) => ({
  kind: 'openrouter', baseUrl: 'https://openrouter.ai/api', apiKey: 'sk-or-abcdefgh1234', authHeader: 'authorization', models: {}, toolSearch: false, ...over,
}) as any;

function deps(over: Partial<WallFallbackDeps> = {}): WallFallbackDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    anthropicKey: async () => { calls.push('anthropic'); return 'sk-ant-api03-xxxxwxyz'; },
    referenceRoute: async (blob) => { calls.push(`ref:${blob.kind}`); return route({ kind: blob.kind }); },
    agentEndpoint: async () => { calls.push('endpoint'); return route({ kind: 'anthropic-compatible' }); },
    loadSetting: async () => null,
    spentSince: async () => 0,
    ...over,
  };
}

let prevKey: string | undefined;
beforeEach(() => { prevKey = process.env.ENCRYPTION_KEY; process.env.ENCRYPTION_KEY = 'test'; });
afterEach(() => { if (prevKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = prevKey; });

describe('resolveWallFallbackCredential', () => {
  it('resolves the Anthropic key with its last four only for display', async () => {
    const c = await resolveWallFallbackCredential({ teamId: 't', workspaceId: 'w', served: 'anthropic' }, deps());
    expect(c).toMatchObject({ served: 'anthropic', last4: 'wxyz', apiKey: 'sk-ant-api03-xxxxwxyz' });
    expect(c?.endpoint).toBeUndefined();
  });

  it('synthesizes an OpenRouter and a LiteLLM reference; reads the endpoint row for "endpoint"', async () => {
    const d = deps();
    expect((await resolveWallFallbackCredential({ teamId: 't', workspaceId: null, served: 'openrouter' }, d))?.endpoint?.kind).toBe('openrouter');
    expect((await resolveWallFallbackCredential({ teamId: 't', workspaceId: null, served: 'litellm' }, d))?.endpoint?.kind).toBe('gateway');
    expect((await resolveWallFallbackCredential({ teamId: 't', workspaceId: null, served: 'endpoint' }, d))?.endpoint?.kind).toBe('anthropic-compatible');
    expect(d.calls).toEqual(['ref:openrouter', 'ref:gateway', 'endpoint']);
  });

  it('is null with nothing stored, on a lookup error, or without ENCRYPTION_KEY', async () => {
    expect(await resolveWallFallbackCredential({ teamId: 't', workspaceId: null, served: 'anthropic' }, deps({ anthropicKey: async () => null }))).toBeNull();
    expect(await resolveWallFallbackCredential({ teamId: 't', workspaceId: null, served: 'litellm' }, deps({ referenceRoute: async () => { throw new Error('x'); } }))).toBeNull();
    delete process.env.ENCRYPTION_KEY;
    expect(await resolveWallFallbackCredential({ teamId: 't', workspaceId: null, served: 'anthropic' }, deps())).toBeNull();
  });
});

describe('wallFallbackSpentToday', () => {
  it('sums since UTC midnight', async () => {
    let since: Date | null = null;
    const n = await wallFallbackSpentToday('t', new Date('2026-11-14T15:00:00Z'), deps({ spentSince: async (_t, s) => { since = s; return 3.5; } }));
    expect(n).toBe(3.5);
    expect(since!.toISOString()).toBe('2026-11-14T00:00:00.000Z');
  });

  it('reads an unreadable sum as the cap reached', async () => {
    expect(await wallFallbackSpentToday('t', new Date(), deps({ spentSince: async () => { throw new Error('db'); } }))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('resolveTeamWallFallback', () => {
  it('waits by default and for no team', async () => {
    expect(await resolveTeamWallFallback({ teamId: 't', workspaceId: 'w' }, deps())).toMatchObject({ use: false, reason: 'wait' });
    expect(await resolveTeamWallFallback({ teamId: null, workspaceId: 'w' }, deps({ loadSetting: async () => ({ fallback: 'anthropic' }) }))).toMatchObject({ use: false, reason: 'wait' });
  });

  it('falls back with a credential and room under the cap', async () => {
    const r = await resolveTeamWallFallback({ teamId: 't', workspaceId: 'w' }, deps({
      loadSetting: async () => ({ fallback: 'anthropic', maxCostPerDayUsd: 10 }),
      spentSince: async () => 4,
    }));
    expect(r).toMatchObject({ use: true, spentTodayUsd: 4 });
  });

  it('waits when the cap is reached or no credential is stored', async () => {
    expect(await resolveTeamWallFallback({ teamId: 't', workspaceId: 'w' }, deps({
      loadSetting: async () => ({ fallback: 'anthropic', maxCostPerDayUsd: 10 }),
      spentSince: async () => 10,
    }))).toMatchObject({ use: false, reason: 'cap_reached', spentTodayUsd: 10 });
    expect(await resolveTeamWallFallback({ teamId: 't', workspaceId: 'w' }, deps({
      loadSetting: async () => ({ fallback: 'openrouter' }),
      referenceRoute: async () => null,
    }))).toMatchObject({ use: false, reason: 'no_credential' });
  });

  it('does not read spend without a cap', async () => {
    let read = false;
    const r = await resolveTeamWallFallback({ teamId: 't', workspaceId: 'w' }, deps({
      loadSetting: async () => ({ fallback: 'litellm' }),
      spentSince: async () => { read = true; return 1e9; },
    }));
    expect(r.use).toBe(true);
    expect(read).toBe(false);
  });

  it('reads an unreadable setting as wait', async () => {
    expect(await resolveTeamWallFallback({ teamId: 't', workspaceId: 'w' }, deps({ loadSetting: async () => { throw new Error('db'); } })))
      .toMatchObject({ use: false, reason: 'wait' });
  });
});

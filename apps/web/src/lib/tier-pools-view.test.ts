import { describe, it, expect } from 'bun:test';
import { buildTierPoolRows, costLabel, winLabel } from './tier-pools-view';
import { summarizeArm } from '@buildd/core/tier-pool';

const tiers = {
  'premium-plus': { provider: 'anthropic', model: 'claude-fable-5-1', source: 'default' },
  premium: { provider: 'anthropic', model: 'claude-opus-5', source: 'team' },
  standard: { provider: 'anthropic', model: 'claude-sonnet-5', source: 'team' },
  budget: { provider: 'anthropic', model: 'claude-haiku-4-5', source: 'catalog' },
} as const;
const bySurface = { agent: tiers, chat: tiers };

const pool = (over: Record<string, unknown> = {}) => ({
  pool: {
    id: 'p1', tier: 'standard', surface: 'chat' as const, mode: 'split', allocation: { inc: 0.8, ch: 0.2 },
    allocationVersion: 3, incumbentFloor: 0.6, explorationCap: 0.3, ...over,
  },
  arms: [
    { id: 'ch', route: 'openrouter' as const, model: 'qwen/qwen3-coder', role: 'challenger' as const, status: 'active', addedAt: '2026-09-02' },
    { id: 'inc', route: 'anthropic' as const, model: 'claude-sonnet-4-6', role: 'incumbent' as const, status: 'active', addedAt: '2026-09-01' },
  ],
  lastChange: { kind: 'allocation', createdAt: '2026-09-03', actorUserId: 'u', actorSystem: null },
});

describe('buildTierPoolRows', () => {
  it('a tier with no pool is pinned to its registry model at 100%', () => {
    const rows = buildTierPoolRows({ tiers: bySurface as never, pools: [], stats: new Map() });
    const agentStd = rows.find(r => r.surface === 'agent' && r.tier === 'standard')!;
    expect(agentStd).toMatchObject({ mode: 'pinned', poolId: null, locked: false });
    expect(agentStd.arms).toEqual([{ id: null, route: 'runner:claude', model: 'claude-sonnet-5', role: 'incumbent', status: 'active', share: 1, stats: null }]);
  });

  it('a split tier shows each surface its own base model and route', () => {
    const split = {
      agent: { ...tiers, standard: { provider: 'openai-codex', model: 'gpt-5.6-codex', source: 'team', surface: 'agent' } },
      chat: { ...tiers, standard: { provider: 'openrouter', model: 'qwen/qwen3-coder', source: 'team', surface: 'chat' } },
    };
    const rows = buildTierPoolRows({ tiers: split as never, pools: [], stats: new Map() });
    expect(rows.find(r => r.surface === 'agent' && r.tier === 'standard')!.arms[0]).toMatchObject({ route: 'runner:codex', model: 'gpt-5.6-codex' });
    expect(rows.find(r => r.surface === 'chat' && r.tier === 'standard')!.arms[0]).toMatchObject({ route: 'openrouter', model: 'qwen/qwen3-coder' });
  });

  it('agent rows cover all four tiers, chat rows the three chat asks for, and premium-plus is locked', () => {
    const rows = buildTierPoolRows({ tiers: bySurface as never, pools: [], stats: new Map() });
    expect(rows.filter(r => r.surface === 'agent').map(r => r.tier)).toEqual(['premium-plus', 'premium', 'standard', 'budget']);
    expect(rows.filter(r => r.surface === 'chat').map(r => r.tier)).toEqual(['premium', 'standard', 'budget']);
    expect(rows.find(r => r.tier === 'premium-plus')!.locked).toBe(true);
  });

  it('lists the base first, shows the registry\'s current model for it, and carries shares and stats', () => {
    const stats = new Map([['ch', summarizeArm([{ severity: 'none', costUsd: 0.01, latencyMs: 100 }])]]);
    const row = buildTierPoolRows({ tiers: bySurface as never, pools: [pool()], stats }).find(r => r.poolId === 'p1')!;
    expect(row.mode).toBe('split');
    expect(row.arms.map(a => [a.id, a.model, a.share])).toEqual([['inc', 'claude-sonnet-5', 0.8], ['ch', 'qwen/qwen3-coder', 0.2]]);
    expect(row.arms[1].stats?.units).toBe(1);
    expect(row.lastChange).toMatchObject({ kind: 'allocation', actor: 'admin' });
  });

  it('a pinned pool shows everything on the base, whatever the saved split', () => {
    const row = buildTierPoolRows({ tiers: bySurface as never, pools: [pool({ mode: 'pinned' })], stats: new Map() }).find(r => r.poolId === 'p1')!;
    expect(row.mode).toBe('pinned');
    expect(row.arms.map(a => a.share)).toEqual([1, 0]);
  });
});

describe('labels', () => {
  it('win rate reads as learning below the minimum', () => {
    const s = summarizeArm(Array.from({ length: 19 }, () => ({ severity: 'none' as const, costUsd: null, latencyMs: null })));
    expect(winLabel(s, 30)).toEqual({ text: '19/30', learning: true });
    expect(winLabel(null, 30).text).toBe('–');
    const full = summarizeArm([...Array.from({ length: 24 }, () => ({ severity: 'none' as const, costUsd: null, latencyMs: null })), ...Array.from({ length: 6 }, () => ({ severity: 'minor' as const, costUsd: null, latencyMs: null }))]);
    expect(winLabel(full, 30)).toEqual({ text: '80%', learning: false });
  });
  it('cost per 1k abbreviates', () => {
    expect(costLabel(summarizeArm([{ severity: null, costUsd: 2.9, latencyMs: null }]))).toBe('$2.9k');
    expect(costLabel(summarizeArm([{ severity: null, costUsd: 0.018, latencyMs: null }]))).toBe('$18');
    expect(costLabel(summarizeArm([{ severity: null, costUsd: 0.004, latencyMs: null }]))).toBe('$4.00');
    expect(costLabel(null)).toBe('–');
  });
});

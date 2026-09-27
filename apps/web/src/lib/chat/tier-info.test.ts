import { describe, expect, it } from 'bun:test';
import { chatTierInfo, loadChatTiers } from './tier-info';

const prices: Record<string, { input: number; output: number }> = {
  'm-cheap': { input: 1, output: 5 },
  'm-mid': { input: 3, output: 15 },
};
const price = (m: string) => prices[m] ?? { input: 0, output: 0 };

describe('chatTierInfo', () => {
  it('per-1k price of the one model a tier maps to', () => {
    expect(chatTierInfo('standard', 'm-mid', [{ model: 'm-mid', weight: 1 }], price)).toEqual({
      tier: 'standard', model: 'm-mid', models: ['m-mid'], inputPer1kUsd: 0.003, outputPer1kUsd: 0.015,
    });
  });

  it('a pooled tier averages over its models, weighted by traffic', () => {
    const even = chatTierInfo('budget', 'm-cheap', [{ model: 'm-cheap', weight: 0.5 }, { model: 'm-mid', weight: 0.5 }], price);
    expect(even.inputPer1kUsd).toBeCloseTo(0.002, 10);
    expect(even.outputPer1kUsd).toBeCloseTo(0.01, 10);
    expect(even.model).toBe('m-cheap');
    expect(even.models).toEqual(['m-cheap', 'm-mid']);
    const skewed = chatTierInfo('budget', 'm-cheap', [{ model: 'm-cheap', weight: 0.75 }, { model: 'anthropic/m-mid', weight: 0.25 }], price);
    expect(skewed.inputPer1kUsd).toBeCloseTo(0.0015, 10);
  });

  it('no allocation: a plain mean', () => {
    const info = chatTierInfo('budget', 'm-cheap', [{ model: 'm-cheap', weight: 0 }, { model: 'm-mid', weight: 0 }], price);
    expect(info.inputPer1kUsd).toBeCloseTo(0.002, 10);
  });

  it('an empty pool falls back to the incumbent', () => {
    expect(chatTierInfo('budget', 'm-cheap', [], price).models).toEqual(['m-cheap']);
  });
});

describe('loadChatTiers', () => {
  it('one row per chat tier, from the team\'s own mapping', async () => {
    const map: Record<string, string> = { budget: 'm-cheap', standard: 'm-mid', premium: 'm-mid' };
    const tiers = await loadChatTiers({ teamId: 't', workspaceId: null }, {
      resolveTierEntry: async (tier: string) => ({ model: map[tier] }) as never,
      price,
      poolModels: async (_t, tier) => (tier === 'budget' ? [{ model: 'm-cheap', weight: 0.5 }, { model: 'm-mid', weight: 0.5 }] : []),
    });
    expect(tiers[0].models).toEqual(['m-cheap', 'm-mid']);
    expect(tiers[1].models).toEqual(['m-mid']);
    expect(tiers.map(t => [t.tier, t.model])).toEqual([['budget', 'm-cheap'], ['standard', 'm-mid'], ['premium', 'm-mid']]);
  });

  it('a tier that fails to resolve is left out, not an error', async () => {
    const tiers = await loadChatTiers({ teamId: 't', workspaceId: null }, {
      resolveTierEntry: async (tier: string) => { if (tier === 'premium') throw new Error('x'); return { model: 'm-mid' } as never; },
      price,
    });
    expect(tiers.map(t => t.tier)).toEqual(['budget', 'standard']);
  });
});

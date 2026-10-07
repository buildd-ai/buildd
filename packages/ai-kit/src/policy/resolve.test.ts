import { describe, expect, it } from 'bun:test';
import { DEFAULT_MODEL_POLICY } from './defaults';
import { allocationPoint, pickArm, resolveModelPolicy } from './resolve';
import type { ModelPolicy, PolicyRoute } from './types';

const r = (model: string, extra: Partial<PolicyRoute> = {}): PolicyRoute => ({ provider: 'openrouter', model, ...extra });

const policy: ModelPolicy = {
  version: '42',
  tiers: { standard: r('base-standard'), premium: r('base-premium', { effort: 'high' }) },
  surfaces: {
    chat: { standard: r('chat-standard') },
    coding: { standard: r('coding-standard', { effort: 'medium' }) },
  },
  overrides: [
    { match: { app: 'cue' }, tier: 'standard', route: r('cue-any-surface') },
    { match: { app: 'cue' }, surface: 'chat', tier: 'standard', route: r('cue-chat') },
    { match: { workspaceId: 'ws1' }, tier: 'standard', route: r('ws1-any-surface') },
    { match: { workspaceId: 'ws1', app: 'cue' }, surface: 'coding', tier: 'standard', route: r('ws1-cue-coding') },
  ],
};

describe('resolver precedence', () => {
  it('app/workspace + surface + tier override beats everything', () => {
    const d = resolveModelPolicy(policy, { surface: 'coding', tier: 'standard', app: 'cue', workspaceId: 'ws1' });
    expect(d).toMatchObject({ model: 'ws1-cue-coding', source: 'override', policyVersion: '42', planId: null });
  });

  it('a workspace override beats an app override; a surface-scoped one beats a both-surface one at equal scope', () => {
    expect(resolveModelPolicy(policy, { surface: 'chat', tier: 'standard', app: 'cue', workspaceId: 'ws1' }).model).toBe('ws1-any-surface');
    expect(resolveModelPolicy(policy, { surface: 'chat', tier: 'standard', app: 'cue' }).model).toBe('cue-chat');
    expect(resolveModelPolicy(policy, { surface: 'coding', tier: 'standard', app: 'cue' }).model).toBe('cue-any-surface');
  });

  it('then surface + tier', () => {
    expect(resolveModelPolicy(policy, { surface: 'chat', tier: 'standard', app: 'other' })).toMatchObject({ model: 'chat-standard', source: 'surface' });
  });

  it('then the base tier', () => {
    expect(resolveModelPolicy(policy, { surface: 'chat', tier: 'premium' })).toMatchObject({ model: 'base-premium', effort: 'high', source: 'tier' });
  });

  it('then the bundled fallback, still stamped with the policy version that left the tier unset', () => {
    const d = resolveModelPolicy(policy, { surface: 'coding', tier: 'budget' });
    expect(d).toMatchObject({ ...DEFAULT_MODEL_POLICY.tiers.budget, source: 'bundled', policyVersion: '42' });
  });

  it('no policy at all resolves from the bundled policy', () => {
    const d = resolveModelPolicy(null, { surface: 'chat', tier: 'premium-plus' });
    expect(d).toMatchObject({ ...DEFAULT_MODEL_POLICY.tiers['premium-plus'], source: 'bundled', policyVersion: 'bundled', effort: null });
  });

  it('an override for another tier never applies', () => {
    expect(resolveModelPolicy(policy, { surface: 'chat', tier: 'premium', app: 'cue', workspaceId: 'ws1' }).model).toBe('base-premium');
  });
});

describe('chat vs coding: one tier vocabulary, two mappings', () => {
  it('the same tier resolves differently per surface, and the caller only ever says "standard"', () => {
    const chat = resolveModelPolicy(policy, { surface: 'chat', tier: 'standard' });
    const coding = resolveModelPolicy(policy, { surface: 'coding', tier: 'standard' });
    expect(chat).toMatchObject({ model: 'chat-standard', surface: 'chat', tier: 'standard', effort: null });
    expect(coding).toMatchObject({ model: 'coding-standard', surface: 'coding', tier: 'standard', effort: 'medium' });
  });

  it('a surface without its own mapping shares the base tier', () => {
    const p: ModelPolicy = { version: '1', tiers: { standard: r('shared') }, surfaces: { chat: { standard: r('chat-only') } } };
    expect(resolveModelPolicy(p, { surface: 'coding', tier: 'standard' }).model).toBe('shared');
    expect(resolveModelPolicy(p, { surface: 'chat', tier: 'standard' }).model).toBe('chat-only');
  });
});

describe('experiments', () => {
  const base: ModelPolicy = { version: '7', tiers: { standard: r('control-model') } };

  it('pinned sends every call to its arm', () => {
    const p: ModelPolicy = { ...base, experiments: [{ key: 'pin', mode: 'pinned', tier: 'standard', arms: [{ name: 'only', route: r('pinned-model') }] }] };
    expect(resolveModelPolicy(p, { surface: 'chat', tier: 'standard' })).toMatchObject({
      model: 'pinned-model', source: 'experiment', experiment: { key: 'pin', mode: 'pinned', arm: 'only' },
    });
  });

  it('shadow never changes the applied route; it only names the challenger', () => {
    const p: ModelPolicy = { ...base, experiments: [{ key: 'sh', mode: 'shadow', tier: 'standard', surface: 'chat', arms: [{ name: 'challenger', route: r('challenger-model') }] }] };
    const d = resolveModelPolicy(p, { surface: 'chat', tier: 'standard' });
    expect(d).toMatchObject({ model: 'control-model', source: 'tier' });
    expect(d.experiment).toEqual({ key: 'sh', mode: 'shadow', arm: 'control', shadow: { arm: 'challenger', provider: 'openrouter', model: 'challenger-model' } });
    // Scoped to chat: coding is untouched.
    expect(resolveModelPolicy(p, { surface: 'coding', tier: 'standard' }).experiment).toBeUndefined();
  });

  it('split is sticky per unit and follows the weights', () => {
    const p: ModelPolicy = {
      ...base,
      experiments: [{ key: 'ab', mode: 'split', tier: 'standard', arms: [{ name: 'a', route: r('a'), weight: 3 }, { name: 'b', route: r('b'), weight: 1 }] }],
    };
    const once = resolveModelPolicy(p, { surface: 'chat', tier: 'standard', workspaceId: 'ws-x' });
    for (let i = 0; i < 5; i++) expect(resolveModelPolicy(p, { surface: 'chat', tier: 'standard', workspaceId: 'ws-x' }).model).toBe(once.model);

    let a = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (resolveModelPolicy(p, { surface: 'chat', tier: 'standard' }, { unit: `u${i}` }).model === 'a') a++;
    expect(a / n).toBeGreaterThan(0.7);
    expect(a / n).toBeLessThan(0.8);
  });

  it('with no unit, split draws at random', () => {
    const p: ModelPolicy = { ...base, experiments: [{ key: 'ab', mode: 'split', tier: 'standard', arms: [{ name: 'a', route: r('a') }, { name: 'b', route: r('b') }] }] };
    expect(resolveModelPolicy(p, { surface: 'chat', tier: 'standard' }, { random: () => 0.1 }).model).toBe('a');
    expect(resolveModelPolicy(p, { surface: 'chat', tier: 'standard' }, { random: () => 0.9 }).model).toBe('b');
  });

  it('pickArm and allocationPoint are deterministic and in range', () => {
    const arms = [{ name: 'a', route: r('a') }, { name: 'b', route: r('b'), weight: 2 }];
    expect(pickArm(arms, 0).name).toBe('a');
    expect(pickArm(arms, 0.34).name).toBe('b');
    expect(pickArm(arms, 0.999999).name).toBe('b');
    const p1 = allocationPoint('k', 'u');
    expect(p1).toBe(allocationPoint('k', 'u'));
    expect(p1).toBeGreaterThanOrEqual(0);
    expect(p1).toBeLessThan(1);
    expect(allocationPoint('k2', 'u')).not.toBe(p1);
  });

  it('an experiment scoped to an app leaves other apps alone', () => {
    const p: ModelPolicy = { ...base, experiments: [{ key: 'pin', mode: 'pinned', tier: 'standard', match: { app: 'cue' }, arms: [{ name: 'x', route: r('x') }] }] };
    expect(resolveModelPolicy(p, { surface: 'chat', tier: 'standard', app: 'cue' }).model).toBe('x');
    expect(resolveModelPolicy(p, { surface: 'chat', tier: 'standard', app: 'other' }).model).toBe('control-model');
  });
});

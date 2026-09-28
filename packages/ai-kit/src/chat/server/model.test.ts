import { describe, expect, it } from 'bun:test';
import type { CallConfig, ResolvedPlan } from '@builddai/ai-kit/models';
import { modelFromPlan } from './model';

const plan = {
  planId: null, planSource: 'fallback', requestedTier: 'standard', tier: 'standard', provider: 'anthropic',
  model: 'claude-sonnet-5', effort: null, limits: { maxTurns: null }, price: null,
} as unknown as ResolvedPlan;
const models = { plan: async () => plan, recordUsage: () => {} };
const fakeModel = { modelId: 'x' } as any;

describe('modelFromPlan with a LiteLLM gateway', () => {
  it('uses the gateway key and an OpenAI-compatible config, without asking for a provider key', async () => {
    const created: CallConfig[] = [];
    let asked = false;
    const resolve = modelFromPlan({
      models,
      key: () => { asked = true; return 'sk-ant'; },
      gateway: { kind: 'litellm', baseURL: 'https://litellm.example.test/v1', apiKey: 'sk-lite' },
      create: ({ config }) => { created.push(config); return fakeModel; },
    });
    const turn = await resolve({});
    expect(turn.ok).toBe(true);
    expect(asked).toBe(false);
    expect(created[0]).toMatchObject({ via: 'litellm', provider: 'anthropic', model: 'anthropic/claude-sonnet-5', apiKey: 'sk-lite' });
  });

  it('refuses no_key when the gateway has no key', async () => {
    const turn = await modelFromPlan({
      models, gateway: { kind: 'litellm', baseURL: 'https://litellm.example.test/v1' }, create: () => fakeModel,
    })({});
    expect(turn).toMatchObject({ ok: false, reason: 'no_key', extra: { provider: 'anthropic', gateway: 'litellm' } });
  });

  it('falls back to the direct path when the gateway resolver returns null', async () => {
    const created: CallConfig[] = [];
    const turn = await modelFromPlan({
      models, key: () => 'sk-ant', gateway: () => null, create: ({ config }) => { created.push(config); return fakeModel; },
    })({});
    expect(turn.ok).toBe(true);
    expect(created[0]).toMatchObject({ via: 'direct', provider: 'anthropic', apiKey: 'sk-ant', baseURL: 'https://api.anthropic.com/v1' });
  });
});

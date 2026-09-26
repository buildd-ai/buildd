import { describe, it, expect } from 'bun:test';
import { openRouterModelId, resolveChatModel } from './models';

describe('openRouterModelId', () => {
  it('maps native Anthropic ids to OpenRouter slugs', () => {
    expect(openRouterModelId('anthropic', 'claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(openRouterModelId('anthropic', 'claude-opus-5-5')).toBe('anthropic/claude-opus-5.5');
    expect(openRouterModelId('anthropic', 'claude-haiku-4-5')).toBe('anthropic/claude-haiku-4.5');
    expect(openRouterModelId('anthropic', 'claude-haiku-4-5-20251001')).toBe('anthropic/claude-haiku-4.5');
  });
  it('keeps OpenAI ids and prefixes them', () => {
    expect(openRouterModelId('openai', 'gpt-5.6-terra')).toBe('openai/gpt-5.6-terra');
  });
  it('leaves an id that is already an OpenRouter slug alone', () => {
    expect(openRouterModelId('openrouter', 'anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
  });
});

// A team whose only key is OpenRouter must still get chat when its tiers point
// at Anthropic or OpenAI models: OpenRouter serves the same model.
describe('resolveChatModel — OpenRouter as the fallback route', () => {
  const tier = (provider: string, model: string) => async () => ({ provider, model, source: 'default' }) as never;
  const keys = (have: Record<string, string>) => async ({ provider }: { provider: string }) =>
    have[provider] ? ({ key: have[provider], scope: 'team' as const }) : null;
  const base = { tier: 'standard' as const, teamId: 't', workspaceId: null, userId: 'u' };

  it('uses the tier provider when its key exists', async () => {
    const r = await resolveChatModel(base, {
      resolveTierEntry: tier('anthropic', 'claude-sonnet-5'),
      resolveInferenceCredential: keys({ anthropic: 'sk-ant-x', openrouter: 'sk-or-x' }) as never,
    });
    expect(r.ok && r.provider).toBe('anthropic');
    expect(r.ok && r.modelId).toBe('claude-sonnet-5');
  });

  it('routes an Anthropic tier through OpenRouter when only an OpenRouter key exists', async () => {
    const r = await resolveChatModel(base, {
      resolveTierEntry: tier('anthropic', 'claude-sonnet-5'),
      resolveInferenceCredential: keys({ openrouter: 'sk-or-x' }) as never,
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.provider).toBe('openrouter');
    expect(r.ok && r.modelId).toBe('anthropic/claude-sonnet-5');
  });

  it('routes an OpenAI tier through OpenRouter too', async () => {
    const r = await resolveChatModel(base, {
      resolveTierEntry: tier('openai', 'gpt-5.6-terra'),
      resolveInferenceCredential: keys({ openrouter: 'sk-or-x' }) as never,
    });
    expect(r.ok && r.modelId).toBe('openai/gpt-5.6-terra');
  });

  it('reports no_key when neither the provider nor OpenRouter has a key', async () => {
    const r = await resolveChatModel(base, {
      resolveTierEntry: tier('anthropic', 'claude-sonnet-5'),
      resolveInferenceCredential: keys({}) as never,
    });
    expect(r).toMatchObject({ ok: false, reason: 'no_key', provider: 'anthropic' });
  });
});

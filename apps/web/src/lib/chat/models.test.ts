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

  it('resolves the tier for the chat surface', async () => {
    const surfaces: unknown[] = [];
    const r = await resolveChatModel(base, {
      resolveTierEntry: (async (_t: string, _team: string, _ws: string | null, surface: unknown) => {
        surfaces.push(surface);
        return surface === 'chat'
          ? { provider: 'anthropic', model: 'chat-model', source: 'team', surface: 'chat' }
          : { provider: 'anthropic', model: 'agent-model', source: 'team', surface: 'agent' };
      }) as never,
      resolveInferenceCredential: keys({ anthropic: 'k' }) as never,
    });
    expect(surfaces).toEqual(['chat']);
    expect(r.ok && r.modelId).toBe('chat-model');
  });

  it('reports no_key when neither the provider nor OpenRouter has a key', async () => {
    const r = await resolveChatModel(base, {
      resolveTierEntry: tier('anthropic', 'claude-sonnet-5'),
      resolveInferenceCredential: keys({}) as never,
    });
    expect(r).toMatchObject({ ok: false, reason: 'no_key', provider: 'anthropic' });
  });

  it('falls back to the team LiteLLM gateway, keeping the planned model for pricing', async () => {
    const r = await resolveChatModel(base, {
      resolveTierEntry: tier('anthropic', 'claude-sonnet-5'),
      resolveInferenceCredential: keys({}) as never,
      resolveLiteLLMGateway: async () => ({ baseURL: 'https://litellm.example.test/v1', apiKey: 'sk-lite' }),
    });
    expect(r).toMatchObject({ ok: true, provider: 'anthropic', modelId: 'claude-sonnet-5', via: 'litellm', keyScope: 'team' });
    expect(r.ok && (r.model as { modelId?: string }).modelId).toBe('anthropic/claude-sonnet-5');
  });

  it('prefers the provider key and OpenRouter over the gateway', async () => {
    let asked = false;
    const r = await resolveChatModel(base, {
      resolveTierEntry: tier('anthropic', 'claude-sonnet-5'),
      resolveInferenceCredential: keys({ openrouter: 'sk-or-x' }) as never,
      resolveLiteLLMGateway: async () => { asked = true; return { baseURL: 'https://litellm.example.test/v1', apiKey: 'k' }; },
    });
    expect(r.ok && r.provider).toBe('openrouter');
    expect(asked).toBe(false);
  });
});

// docs/design/tier-model-pools.md: a chat turn in a split pool runs its drawn
// arm on that arm's exact route; anything that cannot serve it serves the
// incumbent and says so.
describe('resolveChatModel — tier pool step', () => {
  const tier = async () => ({ provider: 'anthropic', model: 'claude-sonnet-5', source: 'team' }) as never;
  const keys = (have: Record<string, string>) => async ({ provider }: { provider: string }) =>
    have[provider] ? ({ key: have[provider], scope: 'team' as const }) : null;
  const pool = { conversationId: 'c1', drawKey: 'c1#0', previous: null, now: new Date('2026-09-26T12:00:00Z') };
  const base = { tier: 'standard' as const, teamId: 't', workspaceId: null, userId: 'u', pool };
  const arm = (role: 'incumbent' | 'challenger', route: string, model: string) => ({
    arm: { id: `arm-${role}`, role, route, model, status: 'active' }, served: false, defaultModel: null, assignedModel: null,
  });

  it('without a pool context, never draws', async () => {
    let called = false;
    const r = await resolveChatModel({ ...base, pool: undefined }, {
      resolveTierEntry: tier, resolveInferenceCredential: keys({ anthropic: 'k' }) as never,
      drawChatPoolArm: (async () => { called = true; return null; }) as never,
    });
    expect(called).toBe(false);
    expect(r.ok && r.pool).toBeUndefined();
  });

  it('no pool row ⇒ the incumbent, unchanged', async () => {
    const r = await resolveChatModel(base, {
      resolveTierEntry: tier, resolveInferenceCredential: keys({ anthropic: 'k' }) as never,
      drawChatPoolArm: (async () => null) as never,
    });
    expect(r.ok && r.modelId).toBe('claude-sonnet-5');
    expect(r.ok && r.pool).toBeUndefined();
  });

  it('a challenger arm runs on its own route and model', async () => {
    const r = await resolveChatModel(base, {
      resolveTierEntry: tier, resolveInferenceCredential: keys({ anthropic: 'k', openrouter: 'or' }) as never,
      drawChatPoolArm: (async () => arm('challenger', 'openrouter', 'qwen/qwen3-coder')) as never,
    });
    expect(r.ok && r.provider).toBe('openrouter');
    expect(r.ok && r.modelId).toBe('qwen/qwen3-coder');
    expect(r.ok && r.pool).toMatchObject({ served: true, defaultModel: 'claude-sonnet-5', assignedModel: 'qwen/qwen3-coder' });
  });

  it('a challenger whose route has no key for this user serves the incumbent, served=false', async () => {
    const r = await resolveChatModel(base, {
      resolveTierEntry: tier, resolveInferenceCredential: keys({ anthropic: 'k' }) as never,
      drawChatPoolArm: (async () => arm('challenger', 'openrouter', 'qwen/qwen3-coder')) as never,
    });
    expect(r.ok && r.modelId).toBe('claude-sonnet-5');
    expect(r.ok && r.pool).toMatchObject({ served: false, assignedModel: 'claude-sonnet-5' });
  });

  it('an incumbent draw is recorded as served', async () => {
    const r = await resolveChatModel(base, {
      resolveTierEntry: tier, resolveInferenceCredential: keys({ anthropic: 'k' }) as never,
      drawChatPoolArm: (async () => arm('incumbent', 'anthropic', 'claude-sonnet-5')) as never,
    });
    expect(r.ok && r.pool).toMatchObject({ served: true });
  });

  it('a pool error serves the incumbent', async () => {
    const r = await resolveChatModel(base, {
      resolveTierEntry: tier, resolveInferenceCredential: keys({ anthropic: 'k' }) as never,
      drawChatPoolArm: (async () => { throw new Error('boom'); }) as never,
    });
    expect(r.ok && r.modelId).toBe('claude-sonnet-5');
  });
});

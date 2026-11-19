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

// docs/specs/local-runner-provider.md §7.2: a chat assignment to the team's own
// runner is exclusive. It is served through the relay or refused; the tier
// registry, every stored key and the gateway are never consulted.
describe('resolveChatModel — chat assigned to the local runner', () => {
  const RUNNER = '22222222-2222-4222-8222-222222222222';
  const NOW = Date.parse('2026-11-14T12:00:00.000Z');
  const base = { tier: 'premium' as const, teamId: 't', workspaceId: null, userId: 'u' };
  const paid = () => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        resolveTierEntry: (async () => { calls.push('tier'); return { provider: 'anthropic', model: 'claude-sonnet-5', source: 'default' }; }) as never,
        resolveInferenceCredential: (async () => { calls.push('credential'); return { key: 'sk-paid', scope: 'team' as const }; }) as never,
        resolveLiteLLMGateway: (async () => { calls.push('gateway'); return null; }) as never,
        drawChatPoolArm: (async () => { calls.push('pool'); return null; }) as never,
        now: () => NOW,
      },
    };
  };
  const pick = (over: Record<string, unknown> = {}) => ({
    teamId: 't', runnerId: RUNNER, chatModel: 'llama3.1:8b', embeddingModel: null, chatAssigned: true,
    runner: {
      id: RUNNER, accountId: 'acc', lastHeartbeatAt: new Date(NOW - 10_000), presenceConnected: true,
      localModels: { server: { kind: 'ollama', version: null, reachable: true, checkedAt: null }, models: [{ name: 'llama3.1:8b', family: null, parameterSize: null, capabilities: ['completion'], dimensions: null, contextLength: null }] },
    },
    ...over,
  }) as never;
  const pool = { conversationId: 'c', drawKey: 'c#0', previous: null, now: new Date(NOW) };

  it('runner online: the local model, on no key, with the pool and every paid lookup skipped', async () => {
    const p = paid();
    const r = await resolveChatModel({ ...base, pool }, { ...p.deps, loadLocalRunnerPick: async () => pick() });
    expect(r).toMatchObject({ ok: true, provider: 'local_runner', via: 'local_runner', modelId: 'llama3.1:8b', tier: 'premium' });
    expect(p.calls).toEqual([]);
  });

  it('AC-26: runner offline is local_runner_unavailable with the runner id, and no key is resolved even though one exists', async () => {
    const p = paid();
    const offline = pick({ runner: { id: RUNNER, accountId: 'acc', lastHeartbeatAt: new Date(NOW - 10_000), presenceConnected: false, localModels: null } });
    const r = await resolveChatModel(base, { ...p.deps, loadLocalRunnerPick: async () => offline });
    expect(r).toMatchObject({ ok: false, reason: 'local_runner_unavailable', provider: 'local_runner', runnerId: RUNNER, code: 'runner_offline' });
    expect(p.calls).toEqual([]);
  });

  it('a runner that does not serve the chat model, and an assignment with no chat model, are refused the same way', async () => {
    const p = paid();
    const other = await resolveChatModel(base, { ...p.deps, loadLocalRunnerPick: async () => pick({ chatModel: 'qwen3:14b' }) });
    expect(other).toMatchObject({ ok: false, reason: 'local_runner_unavailable', code: 'model_missing' });
    const none = await resolveChatModel(base, { ...p.deps, loadLocalRunnerPick: async () => pick({ chatModel: null }) });
    expect(none).toMatchObject({ ok: false, reason: 'local_runner_unavailable', code: 'model_missing' });
    expect(p.calls).toEqual([]);
  });

  it('AC-28: chat not assigned to the local runner resolves as before, whatever the embedding pick is', async () => {
    const p = paid();
    const r = await resolveChatModel(base, { ...p.deps, loadLocalRunnerPick: async () => pick({ chatAssigned: false, embeddingModel: 'nomic-embed-text' }) });
    expect(r.ok && r.provider).toBe('anthropic');
    expect(p.calls).toContain('credential');
  });
});

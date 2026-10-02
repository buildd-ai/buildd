import { describe, it, expect } from 'bun:test';
import { resolveInferenceRoute, isRouteVendor, type ResolveInferenceRouteDeps } from '../inference-route';

/**
 * One route order for every server-side call: the vendor's own API, then
 * OpenRouter, then the team's LiteLLM gateway. The resolvers behind it are
 * injected, so this runs without a DB.
 */

function deps(keys: Partial<Record<string, string>>, gateway: { apiKey: string; baseURL: string } | null = null) {
  const asked: string[] = [];
  const d: ResolveInferenceRouteDeps = {
    resolveInferenceCredential: async o => {
      asked.push(String(o.provider));
      const key = keys[String(o.provider)];
      return key ? { key, scope: 'team', secretId: 's', purpose: 'inference_key' } : null;
    },
    resolveLiteLLMGateway: async () => { asked.push('litellm'); return gateway; },
  };
  return { d, asked };
}

const base = { teamId: 't', model: 'claude-haiku-4-5-20251001' } as const;

describe('resolveInferenceRoute', () => {
  it("uses the vendor's own key first", async () => {
    const { d, asked } = deps({ anthropic: 'sk-ant', openrouter: 'sk-or' });
    const r = await resolveInferenceRoute({ ...base, vendor: 'anthropic' }, d);
    expect(r).toMatchObject({ route: 'anthropic', wire: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1', apiKey: 'sk-ant', modelId: base.model });
    expect(asked).toEqual(['anthropic']);
  });

  it('falls back to OpenRouter with its slug, keeping the planned model', async () => {
    const { d } = deps({ openrouter: 'sk-or' });
    const r = await resolveInferenceRoute({ ...base, vendor: 'anthropic' }, d);
    expect(r).toMatchObject({ route: 'openrouter', wire: 'openai-chat', modelId: 'anthropic/claude-haiku-4.5', model: base.model, vendor: 'anthropic' });
  });

  it('falls back to the gateway last, as vendor/model', async () => {
    const { d, asked } = deps({}, { apiKey: 'sk-lite', baseURL: 'https://gw.example.test/v1' });
    const r = await resolveInferenceRoute({ ...base, vendor: 'openai', model: 'gpt-5' }, d);
    expect(r).toMatchObject({ route: 'litellm', baseURL: 'https://gw.example.test/v1', modelId: 'openai/gpt-5', keyScope: 'team' });
    expect(asked).toEqual(['openai', 'openrouter', 'litellm']);
  });

  it('serves an OpenRouter-only model on OpenRouter, then the gateway', async () => {
    const { d, asked } = deps({}, { apiKey: 'k', baseURL: 'https://gw.example.test/v1' });
    const r = await resolveInferenceRoute({ ...base, vendor: 'openrouter', model: 'google/gemini-3-flash' }, d);
    expect(asked).toEqual(['openrouter', 'litellm']);
    expect(r?.modelId).toBe('openrouter/google/gemini-3-flash');
  });

  it('returns null with no credential, and a failing lookup does not stop the next route', async () => {
    expect(await resolveInferenceRoute({ ...base, vendor: 'anthropic' }, deps({}).d)).toBeNull();
    const d: ResolveInferenceRouteDeps = {
      resolveInferenceCredential: async () => { throw new Error('db down'); },
      resolveLiteLLMGateway: async () => ({ apiKey: 'k', baseURL: 'https://gw.example.test/v1' }),
    };
    expect((await resolveInferenceRoute({ ...base, vendor: 'anthropic' }, d))?.route).toBe('litellm');
  });

  it('passes the caller scope and key policy through to the key resolver', async () => {
    let seen: any;
    const d: ResolveInferenceRouteDeps = {
      resolveInferenceCredential: async o => { seen = o; return null; },
      resolveLiteLLMGateway: async () => null,
    };
    await resolveInferenceRoute({ ...base, vendor: 'anthropic', workspaceId: 'w', userId: 'u', accountId: 'a', keyPolicy: 'own' }, d);
    expect(seen).toMatchObject({ provider: 'openrouter', teamId: 't', workspaceId: 'w', userId: 'u', accountId: 'a', keyPolicy: 'own' });
  });

  it('knows which tier providers are vendors a route can serve', () => {
    expect(['anthropic', 'openai', 'openrouter'].every(isRouteVendor)).toBe(true);
    expect(isRouteVendor('openai-codex')).toBe(false);
  });
});

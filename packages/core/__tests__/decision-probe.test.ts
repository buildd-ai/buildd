import { describe, expect, it } from 'bun:test';
import { probeDecisionModel, providerRejectionText } from '../decision-probe';

/**
 * Saving a decision model runs one probe decision through the exact route a
 * real call takes, and refuses with the provider's own words when it fails.
 * Route resolution and transport are injected: no DB, no key, no network.
 * Synthetic fixtures only.
 */

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'synthetic-cf-token-0000000000000000';
const CLEF = { endpoint: 'systemone' as const, model: 'clef', via: 'cloudflare' as const };
const QWEN_LITELLM = { endpoint: 'chat' as const, model: 'qwen3-8b', via: 'litellm' as const };
const QWEN_OPENROUTER = { endpoint: 'chat' as const, model: 'qwen/qwen3-8b', via: 'openrouter' as const };
const scope = { teamId: '00000000-0000-4000-8000-000000000001', userId: 'user-1' };
const CF_AUTH_ERROR = JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }], messages: [], result: null });

const workersAiRoute = async () => ({
  apiKey: TOKEN,
  endpoint: { kind: 'workers-ai' as const, baseURL: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run` },
  model: 'clef',
});

describe("providerRejectionText: the provider's own words", () => {
  it("reads Cloudflare's errors[] with their codes", () => {
    expect(providerRejectionText(401, CF_AUTH_ERROR)).toBe('HTTP 401: Authentication error (code 10000)');
  });

  it("reads an OpenAI-style error.message", () => {
    expect(providerRejectionText(401, JSON.stringify({ error: { message: 'Invalid API key', code: 401 } }))).toBe('HTTP 401: Invalid API key');
  });

  it('falls back to the redacted body excerpt', () => {
    expect(providerRejectionText(502, `upstream said no, Bearer ${TOKEN}`)).toBe('HTTP 502: upstream said no, Bearer [redacted]');
  });
});

describe('probeDecisionModel', () => {
  it('passes when the route answers', async () => {
    const seen: any[] = [];
    const r = await probeDecisionModel(CLEF, scope, {
      resolveRoute: workersAiRoute,
      call: async (p: any) => {
        seen.push(p);
        const key = Object.keys(p.questions)[0];
        return { ok: true, answers: { [key]: { type: 'choice', choice: 'yes', confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } } }, model: 'clef', usage: { inputTokens: 5, outputTokens: 1, costUsd: null }, latencyMs: 40, attempts: 1 } as any;
      },
    });
    expect(r).toMatchObject({ ok: true, model: 'clef' });
    // The exact route: its key, endpoint and model, not a re-resolved one.
    expect(seen[0]).toMatchObject({ apiKey: TOKEN, model: 'clef', endpoint: { kind: 'workers-ai' } });
  });

  it("refuses with Cloudflare's own text when Workers AI rejects the token", async () => {
    const r = await probeDecisionModel(CLEF, scope, {
      resolveRoute: workersAiRoute,
      call: async () => ({ ok: false, error: { kind: 'provider_error', status: 401, body: CF_AUTH_ERROR }, latencyMs: 60, attempts: 1 }) as any,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('Cloudflare rejected');
    expect(r.error).toContain('HTTP 401: Authentication error (code 10000)');
    expect(r.error).not.toContain(TOKEN);
  });

  it('refuses when there is no route at all, naming what is missing', async () => {
    const none = async () => ({ apiKey: null, model: 'clef' });
    const cf = await probeDecisionModel(CLEF, scope, { resolveRoute: none, call: async () => { throw new Error('must not call'); } });
    expect(cf).toMatchObject({ ok: false });
    expect(!cf.ok && cf.error).toContain('Cloudflare');
    const ll = await probeDecisionModel(QWEN_LITELLM, scope, { resolveRoute: async () => ({ apiKey: null, model: 'qwen3-8b' }), call: async () => { throw new Error('must not call'); } });
    expect(!ll.ok && ll.error).toContain('LiteLLM');
    const or = await probeDecisionModel(QWEN_OPENROUTER, scope, { resolveRoute: async () => ({ apiKey: null, model: 'qwen/qwen3-8b' }), call: async () => { throw new Error('must not call'); } });
    expect(!or.ok && or.error).toContain('OpenRouter');
  });

  it('names the LiteLLM gateway and OpenRouter in their own rejections', async () => {
    const reject = async () => ({ ok: false, error: { kind: 'provider_error', status: 401, body: JSON.stringify({ error: { message: 'Invalid API key' } }) }, latencyMs: 9, attempts: 1 }) as any;
    const route = async () => ({ apiKey: 'k-synthetic', endpoint: { kind: 'chat' as const, baseURL: 'https://litellm.example.com/v1', provider: 'openai' as const }, model: 'qwen3-8b' });
    const ll = await probeDecisionModel(QWEN_LITELLM, scope, { resolveRoute: route, call: reject });
    expect(!ll.ok && ll.error).toBe('The LiteLLM gateway rejected a test decision: HTTP 401: Invalid API key');
    const or = await probeDecisionModel(QWEN_OPENROUTER, scope, { resolveRoute: route, call: reject });
    expect(!or.ok && or.error).toBe('OpenRouter rejected a test decision: HTTP 401: Invalid API key');
  });

  it('refuses a model that answers without probabilities', async () => {
    const r = await probeDecisionModel(QWEN_OPENROUTER, scope, {
      resolveRoute: async () => ({ apiKey: 'k-synthetic', endpoint: { kind: 'chat' as const, baseURL: 'https://openrouter.ai/api/v1', provider: 'openrouter' as const }, model: 'qwen/qwen3-8b' }),
      call: async () => ({ ok: false, error: { kind: 'uncalibrated', message: 'no logprobs' }, latencyMs: 9, attempts: 1 }) as any,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('logprobs');
  });

  it('a route lookup that throws is a refusal, not a crash', async () => {
    const r = await probeDecisionModel(CLEF, scope, { resolveRoute: async () => { throw new Error('db down'); }, call: async () => { throw new Error('x'); } });
    expect(r.ok).toBe(false);
  });
});

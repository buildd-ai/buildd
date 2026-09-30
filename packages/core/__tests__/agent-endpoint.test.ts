/**
 * The agent model endpoint secret (docs/design/agent-model-endpoint.md §1, §5).
 * Pure helpers only; resolution is covered in agent-endpoint-resolve.test.ts.
 * Fixtures are illustrative, nothing here is a real key.
 */
import { describe, expect, it } from 'bun:test';
import {
  AGENT_ENDPOINT_PURPOSE,
  OPENROUTER_AGENT_BASE_URL,
  agentBaseUrlFromGateway,
  mapAgentModel,
  parseAgentEndpointBlob,
  resolveEndpointFromBlob,
  serializeAgentEndpoint,
  validateAgentEndpointInput,
} from '../agent-endpoint';
import { openRouterModelId } from '../openrouter-id';

describe('agent endpoint blob', () => {
  it('purpose is agent_endpoint', () => {
    expect(AGENT_ENDPOINT_PURPOSE).toBe('agent_endpoint');
  });

  it('round-trips a self-contained endpoint and normalises the URL', () => {
    const v = validateAgentEndpointInput({
      kind: 'anthropic-compatible',
      baseUrl: ' https://litellm.example.com/ ',
      apiKey: ' sk-agent-1 ',
      authHeader: 'x-api-key',
      models: { 'claude-sonnet-5': 'team-sonnet' },
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const stored = serializeAgentEndpoint(v.blob);
    expect(JSON.parse(stored)).toEqual({
      kind: 'anthropic-compatible',
      baseUrl: 'https://litellm.example.com',
      apiKey: 'sk-agent-1',
      authHeader: 'x-api-key',
      models: { 'claude-sonnet-5': 'team-sonnet' },
    });
    expect(parseAgentEndpointBlob(stored)).toEqual(v.blob);
  });

  it('defaults authHeader to authorization and OpenRouter to its API root', () => {
    const v = validateAgentEndpointInput({ kind: 'openrouter', apiKey: 'sk-or-1' });
    expect(v.ok && v.blob).toEqual({ kind: 'openrouter', baseUrl: OPENROUTER_AGENT_BASE_URL, apiKey: 'sk-or-1', authHeader: 'authorization' });
  });

  it('the gateway reference carries no key and no URL unless overridden', () => {
    const v = validateAgentEndpointInput({ kind: 'gateway' });
    expect(v.ok && v.blob).toEqual({ kind: 'gateway' });
    const o = validateAgentEndpointInput({ kind: 'gateway', agentBaseUrl: 'https://litellm.example.com/anthropic/' });
    expect(o.ok && o.blob).toEqual({ kind: 'gateway', agentBaseUrl: 'https://litellm.example.com/anthropic' });
    // A key in a gateway reference is refused: it would silently not be used.
    expect(validateAgentEndpointInput({ kind: 'gateway', apiKey: 'sk-x' }).ok).toBe(false);
  });

  it('refuses what it cannot route', () => {
    const bad = [
      null,
      'x',
      {},
      { kind: 'anthropic' },
      { kind: 'anthropic-compatible', apiKey: 'k' },
      { kind: 'anthropic-compatible', baseUrl: 'http://litellm.example.com', apiKey: 'k' },
      { kind: 'anthropic-compatible', baseUrl: 'https://u:p@litellm.example.com', apiKey: 'k' },
      { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: '' },
      { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: 'has space' },
      { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: 'k', authHeader: 'cookie' },
      { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: 'k', models: { a: 1 } },
      { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: 'k', models: [] },
    ];
    for (const b of bad) expect(validateAgentEndpointInput(b).ok).toBe(false);
  });

  it('reads anything malformed as no endpoint', () => {
    expect(parseAgentEndpointBlob(null)).toBeNull();
    expect(parseAgentEndpointBlob('sk-plain')).toBeNull();
    expect(parseAgentEndpointBlob(JSON.stringify({ kind: 'anthropic-compatible', baseUrl: 'http://x.example.com', apiKey: 'k' }))).toBeNull();
  });
});

describe('gateway reference → agent base', () => {
  it('drops a trailing /v1 from the OpenAI root', () => {
    expect(agentBaseUrlFromGateway('https://litellm.example.com/v1')).toBe('https://litellm.example.com');
    expect(agentBaseUrlFromGateway('https://litellm.example.com/v1/')).toBe('https://litellm.example.com');
    expect(agentBaseUrlFromGateway('https://litellm.example.com')).toBe('https://litellm.example.com');
    expect(agentBaseUrlFromGateway('https://litellm.example.com/proxy/v1')).toBe('https://litellm.example.com/proxy');
  });

  it('resolves to the gateway key and derived base, or the override', () => {
    const gw = { baseURL: 'https://litellm.example.com/v1', apiKey: 'sk-gw' };
    expect(resolveEndpointFromBlob({ kind: 'gateway' }, gw)).toEqual({
      kind: 'gateway', baseUrl: 'https://litellm.example.com', apiKey: 'sk-gw', authHeader: 'authorization', models: {},
    });
    expect(resolveEndpointFromBlob({ kind: 'gateway', agentBaseUrl: 'https://litellm.example.com/anthropic' }, gw)?.baseUrl)
      .toBe('https://litellm.example.com/anthropic');
    // A reference with no gateway to point at routes nothing.
    expect(resolveEndpointFromBlob({ kind: 'gateway' }, null)).toBeNull();
  });

  it('a self-contained blob ignores the gateway', () => {
    const r = resolveEndpointFromBlob({ kind: 'openrouter', baseUrl: OPENROUTER_AGENT_BASE_URL, apiKey: 'sk-or', authHeader: 'authorization' }, { baseURL: 'https://litellm.example.com/v1', apiKey: 'sk-gw' });
    expect(r).toEqual({ kind: 'openrouter', baseUrl: OPENROUTER_AGENT_BASE_URL, apiKey: 'sk-or', authHeader: 'authorization', models: {} });
  });
});

describe('mapAgentModel (§5)', () => {
  it('openrouter uses the chat rule (dotted, undated)', () => {
    expect(mapAgentModel({ kind: 'openrouter', models: {} }, 'claude-haiku-4-5-20251001')).toBe(openRouterModelId('anthropic', 'claude-haiku-4-5-20251001'));
    expect(mapAgentModel({ kind: 'openrouter', models: {} }, 'claude-haiku-4-5-20251001')).toBe('anthropic/claude-haiku-4.5');
  });

  it('gateway / anthropic-compatible: the alias map, else the id unchanged, never a provider/ prefix', () => {
    for (const kind of ['gateway', 'anthropic-compatible'] as const) {
      expect(mapAgentModel({ kind, models: { 'claude-sonnet-5': 'team-sonnet' } }, 'claude-sonnet-5')).toBe('team-sonnet');
      expect(mapAgentModel({ kind, models: {} }, 'claude-opus-4-8')).toBe('claude-opus-4-8');
    }
  });
});

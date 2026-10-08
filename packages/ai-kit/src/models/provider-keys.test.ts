import { describe, expect, it } from 'bun:test';
import { ROUTES, routeOrder, type RouteSpec, type RouteId } from './routes';
import { PROVIDER_KEY_CAPABILITIES, PERSONAL_KEY_PROVIDERS, providerKeyCapability } from './provider-keys';

describe('route-backed provider key contract', () => {
  it('projects every route without credentials and excludes team gateways from personal keys', () => {
    expect(PERSONAL_KEY_PROVIDERS).toEqual(['anthropic', 'openai', 'openrouter']);
    expect(PROVIDER_KEY_CAPABILITIES.map(p => p.id)).toEqual(Object.keys(ROUTES) as RouteId[]);
    for (const p of PROVIDER_KEY_CAPABILITIES) {
      expect(p.label).toBe(ROUTES[p.id].label);
      expect(p.personalKeys).toBe(ROUTES[p.id].personalKeys);
      expect(p.verification.path).toBe(ROUTES[p.id].verifyPath);
      expect(p.verification.auth).toBe(ROUTES[p.id].auth);
      expect(p).not.toHaveProperty('apiKey');
      expect(p.validation).toEqual({ minLength: 20, allowWhitespace: false, prefixIsHint: true });
    }
    expect(providerKeyCapability('litellm')?.personalKeys).toBe(false);
    expect(providerKeyCapability('openai-codex')).toBeNull();
  });
  it('carries validation and legacy semantics beside route auth facts', () => {
    expect(providerKeyCapability('anthropic')).toMatchObject({ prefix: 'sk-ant-api', rejectedPrefixes: ['sk-ant-oat'], purposes: ['inference_key', 'anthropic_api_key'] });
    expect(providerKeyCapability('openrouter')?.purposes).toEqual(['inference_key', 'decision_key']);
    expect(providerKeyCapability('openai')?.purposes).toEqual(['inference_key']);
  });
  it('discovers compatible gateways from the registry rather than a fixed fallback table', () => {
    const entry: RouteSpec = ROUTES.openai;
    const original = entry.vendors;
    try {
      entry.vendors = 'any';
      expect(routeOrder('anthropic')).toContain('openai');
    } finally { entry.vendors = original; }
  });
});

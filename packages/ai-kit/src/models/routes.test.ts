import { describe, it, expect } from 'bun:test';
import {
  ROUTES, ROUTE_IDS, routeOrder, routeModelId, routeAuthHeaders, routeAttributionHeaders, openRouterModelId,
  PROVIDER_BASE_URLS, gatewayModel, KIT_PROVIDERS,
} from './index';

describe('route registry', () => {
  it('has one entry per route id, keyed by its own id', () => {
    for (const id of ROUTE_IDS) expect(ROUTES[id].id).toBe(id);
  });

  it("gives every vendor a direct route that is its own API", () => {
    for (const v of KIT_PROVIDERS) {
      expect(ROUTES[v].baseURL).toBe(PROVIDER_BASE_URLS[v]);
      expect(routeOrder(v)[0]).toBe(v);
    }
  });

  it('orders own API, then OpenRouter, then the gateway', () => {
    expect(routeOrder('anthropic')).toEqual(['anthropic', 'openrouter', 'litellm']);
    expect(routeOrder('openai')).toEqual(['openai', 'openrouter', 'litellm']);
    expect(routeOrder('openrouter')).toEqual(['openrouter', 'litellm']);
  });

  it('keeps a gateway team-only, with its URL on the credential', () => {
    expect(ROUTES.litellm.personalKeys).toBe(false);
    expect(ROUTES.litellm.baseURL).toBeNull();
  });
});

describe('routeModelId', () => {
  it('sends the native id on a direct route', () => {
    expect(routeModelId('anthropic', 'anthropic', 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
  });

  it('rewrites to the OpenRouter slug', () => {
    expect(routeModelId('openrouter', 'anthropic', 'claude-haiku-4-5-20251001')).toBe('anthropic/claude-haiku-4.5');
    expect(routeModelId('openrouter', 'openai', 'gpt-5.1')).toBe('openai/gpt-5.1');
    expect(openRouterModelId('openrouter', 'x/y')).toBe('x/y');
  });

  it("follows a gateway's aliases, prefix, or LiteLLM's vendor/model", () => {
    expect(routeModelId('litellm', 'anthropic', 'claude-x')).toBe('anthropic/claude-x');
    expect(routeModelId('litellm', 'anthropic', 'claude-x', { prefix: false })).toBe('claude-x');
    expect(routeModelId('litellm', 'anthropic', 'claude-x', { models: { 'anthropic/claude-x': 'fast' } })).toBe('fast');
    expect(gatewayModel({ models: { 'claude-x': 'b' } }, 'anthropic', 'claude-x')).toBe('b');
  });
});

describe('route headers', () => {
  it('authenticates by the route scheme', () => {
    expect(routeAuthHeaders('anthropic', 'k')).toEqual({ 'x-api-key': 'k' });
    expect(routeAuthHeaders('openrouter', 'k')).toEqual({ Authorization: 'Bearer k' });
  });

  it('attributes only where the route takes it', () => {
    expect(routeAttributionHeaders('openrouter', { appName: 'a', appUrl: 'https://a.test' })).toEqual({ 'X-Title': 'a', 'HTTP-Referer': 'https://a.test' });
    expect(routeAttributionHeaders('litellm', { appName: 'a' })).toEqual({});
  });
});

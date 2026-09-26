import { describe, expect, it } from 'bun:test';
import { openRouterConnectHref, providerFlowMessage } from './ConnectOpenRouterButton';

describe('openRouterConnectHref', () => {
  it('points at the start route with scope, team and where to come back', () => {
    const u = new URL(openRouterConnectHref({ scope: 'team', teamId: 't-1', returnTo: '/app/home' }), 'http://x');
    expect(u.pathname).toBe('/api/inference-keys/openrouter/start');
    expect(Object.fromEntries(u.searchParams)).toEqual({ scope: 'team', teamId: 't-1', returnTo: '/app/home' });
  });
});

describe('providerFlowMessage', () => {
  const p = (q: string) => new URLSearchParams(q);
  it('reads the callback outcome', () => {
    expect(providerFlowMessage(p('connected=openrouter'))).toEqual({ tone: 'ok', text: 'OpenRouter is connected.' });
    expect(providerFlowMessage(p('provider_error=cancelled'))?.tone).toBe('err');
    expect(providerFlowMessage(p('provider_error=something-new'))?.text).toBe('Connecting OpenRouter failed. Try again.');
    expect(providerFlowMessage(p(''))).toBeNull();
  });
});

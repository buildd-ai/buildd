/**
 * The admin's provider step on Home, mounted in happy-dom. Fixtures are
 * illustrative; nothing here is a real key.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/home', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let search = new URLSearchParams();
const refresh = mock(() => {});
mock.module('next/navigation', () => ({
  usePathname: () => '/app/home',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh }),
  useSearchParams: () => search,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ProviderOnboardingCard, onboardingFoldKey } = await import('./ProviderOnboardingCard');

const calls: { method: string; url: string; body: any }[] = [];
beforeEach(() => {
  calls.length = 0;
  search = new URLSearchParams();
  refresh.mockClear();
  window.localStorage.clear();
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(url).startsWith('/api/inference-keys')) {
      return new Response(JSON.stringify({ key: { id: 'k', provider: 'openrouter', scope: 'team', last4: 'abcd', health: 'healthy', source: 'inference_key' } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<ProviderOnboardingCard teamId="t-1" />); });
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

describe('ProviderOnboardingCard', () => {
  it('offers three ways in one screen, OpenRouter first', async () => {
    await mount();
    const text = host.textContent ?? '';
    expect(text).toContain('Connect a model provider');
    const connect = host.querySelector('[data-testid="connect-openrouter"]') as HTMLAnchorElement;
    expect(connect.getAttribute('href')).toContain('/api/inference-keys/openrouter/start?scope=team&teamId=t-1');
    expect(text.indexOf('OpenRouter')).toBeLessThan(text.indexOf('Paste a key'));
    expect(text.indexOf('Paste a key')).toBeLessThan(text.indexOf('Let each person connect their own'));
    expect(text).toContain('1 of 2');
  });

  it('pastes a key into the team scope', async () => {
    await mount();
    const input = host.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'sk-or-v1-example-example-example');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('Save and test').click(); });
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ teamId: 't-1', provider: 'openrouter', scope: 'team' });
    expect(refresh).toHaveBeenCalled();
  });

  it('"Let each person connect their own" sets the own-key policy', async () => {
    await mount();
    await act(async () => { button('Use personal keys').click(); });
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/teams/t-1', body: { inferenceKeyPolicy: 'own' } });
  });

  it('"Not now" folds it to one line that remembers, and Resume brings it back', async () => {
    await mount();
    await act(async () => { button('Not now').click(); });
    expect(host.querySelector('[data-testid="provider-onboarding"]')?.getAttribute('data-folded')).toBe('true');
    expect(window.localStorage.getItem(onboardingFoldKey('t-1'))).toBe('1');
    act(() => root.unmount());
    host.remove();
    await mount();
    expect(host.querySelector('[data-testid="provider-onboarding"]')?.getAttribute('data-folded')).toBe('true');
    await act(async () => { button('Resume').click(); });
    expect(host.querySelector('[data-testid="provider-onboarding"]')?.getAttribute('data-folded')).toBe('false');
  });

  it('says why a Connect OpenRouter round trip failed', async () => {
    search = new URLSearchParams('provider_error=cancelled');
    await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('You closed OpenRouter');
  });
});

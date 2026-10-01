/**
 * Phone-width behavior for the provider onboarding card: "Paste a key" and
 * "Let each person connect their own" collapse behind a "More ways to
 * connect" disclosure, so OpenRouter (the recommended path) is the only
 * thing visible without a tap. See ProviderOnboardingCard.dom.test.tsx for
 * the desktop-width (all three options flat) behavior.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/home', width: 375, height: 812 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const search = new URLSearchParams();
mock.module('next/navigation', () => ({
  usePathname: () => '/app/home',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => search,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ProviderOnboardingCard } = await import('./ProviderOnboardingCard');

beforeEach(() => {
  window.localStorage.clear();
  globalThis.fetch = mock(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
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

describe('ProviderOnboardingCard on phone', () => {
  it('shows OpenRouter directly and folds the other two ways behind a disclosure', async () => {
    await mount();
    const text = host.textContent ?? '';
    expect(text).toContain('OpenRouter');
    expect(text).toContain('More ways to connect');

    const details = host.querySelector('details');
    expect(details).not.toBeNull();
    // "Paste a key" and the personal-keys option live inside the disclosure,
    // not as flat siblings of the OpenRouter row.
    expect(details?.textContent).toContain('Paste a key');
    expect(details?.textContent).toContain('Let each person connect their own');
  });

  it('keeps the bottom-nav clearance padding on the card', async () => {
    await mount();
    const section = host.querySelector('[data-testid="provider-onboarding"]');
    expect(section?.className).toContain('pb-8');
  });
});

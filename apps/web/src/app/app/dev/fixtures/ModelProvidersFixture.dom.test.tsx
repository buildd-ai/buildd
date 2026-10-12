/**
 * The model-providers fixture's lone variant: one OpenRouter team key, so the
 * page draws the one Used for line and no table. The full fixture draws the table.
 * The stored-policy variant draws the key-rule line; the full one, with no
 * policy stored, does not.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/dev/fixtures' });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/app/dev/fixtures',
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ModelProvidersFixture } = await import('./ModelProvidersFixture');

const realFetch = window.fetch;
let root: ReturnType<typeof createRoot>;
let host: HTMLElement;

async function mount(variant?: 'full' | 'lone' | 'stored-policy') {
  window.fetch = realFetch;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<ModelProvidersFixture variant={variant} />); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('ModelProvidersFixture', () => {
  it('lone: one OpenRouter key draws the one Used for line, not the table', async () => {
    await mount('lone');
    expect(host.querySelector('[data-testid="used-for"]')).toBeNull();
    expect(host.querySelector('[data-testid="provider-lone"]')?.textContent).toStartWith('OpenRouter is used for');
  });

  it('full: several providers draw the Used for table', async () => {
    await mount();
    expect(host.querySelector('[data-testid="used-for"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="provider-lone"]')).toBeNull();
    expect(host.querySelector('[data-testid="credential-policy-line"]')).toBeNull();
  });

  it('stored-policy: a stored "team keys only" draws the key-rule line and its reset', async () => {
    await mount('stored-policy');
    expect(host.querySelector('[data-testid="credential-policy-line"]')?.textContent).toBe('This team uses team keys only.');
    expect(host.querySelector('[data-testid="credential-policy-reset"]')).not.toBeNull();
  });
});

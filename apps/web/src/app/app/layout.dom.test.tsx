/**
 * AppLayout must not fetch a session. It used to wrap every /app/* route
 * (including the auth-free /app/dev fixtures) in next-auth's SessionProvider,
 * which eagerly calls GET /api/auth/session on mount — logging MissingSecret
 * when no local auth secret is configured, for a page nothing even reads
 * `useSession()` on. Nothing in the app calls `useSession()`; `signIn`/`signOut`
 * (the only next-auth/react APIs actually used) work without the provider.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/dev/chat', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: AppLayout } = await import('./layout');

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : input.toString());
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('AppLayout', () => {
  it('renders children without fetching a session', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(<AppLayout><div data-testid="child">fixture</div></AppLayout>); });
    // Let any deferred effects (e.g. a stray SessionProvider mount) run.
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    expect(host.querySelector('[data-testid="child"]')?.textContent).toBe('fixture');
    expect(calls.some(url => url.includes('/api/auth/session'))).toBe(false);
  });
});

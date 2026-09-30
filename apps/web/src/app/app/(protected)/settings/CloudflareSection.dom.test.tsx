/**
 * Cloudflare token section: the browser sends the token once, then only ever
 * sees masked metadata; storing verifies straight away.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/runners', width: 1280, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: CloudflareSection } = await import('./CloudflareSection');

const TOKEN = 'cf_test_token_not_real_000000000000000000';
const ACCOUNT = '0123456789abcdef0123456789abcdef';

const STORED = {
  id: '11111111-1111-4111-8111-111111111111', accountId: '0123…cdef', aiGatewayId: null, tokenHint: '…0000',
  readable: true, healthStatus: 'healthy', lastVerifiedAt: null, lastVerificationError: null, createdAt: new Date(0).toISOString(),
};

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

type Call = { url: string; init?: RequestInit };
function installFetch(state: { stored: boolean }) {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('/api/cloudflare/credential')) {
      return new Response(JSON.stringify({ credential: state.stored ? STORED : null }), { status: 200 });
    }
    if (url === '/api/secrets' && init?.method === 'POST') {
      state.stored = true;
      return new Response(JSON.stringify({ id: STORED.id, requeued: 0 }), { status: 200 });
    }
    if (url.endsWith('/verify')) {
      return new Response(JSON.stringify({ verified: true, error: null, tokenKind: 'account', tokenStatus: 'active' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<CloudflareSection teams={[{ id: 't1', name: 'Team 1' }]} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function setInput(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CloudflareSection', () => {
  it('shows the add form when nothing is stored', async () => {
    installFetch({ stored: false });
    await mount();
    expect(host.querySelector('input[aria-label="Cloudflare API token"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cloudflare-credential"]')).toBeNull();
  });

  it('stores the token as cloudflare_token JSON, then verifies it', async () => {
    const calls = installFetch({ stored: false });
    await mount();
    await act(async () => {
      setInput(host.querySelector('input[aria-label="Cloudflare API token"]')!, TOKEN);
      setInput(host.querySelector('input[aria-label="Cloudflare account ID"]')!, ACCOUNT);
    });
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Store and verify')!;
    await act(async () => { button.click(); await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const post = calls.find((c) => c.url === '/api/secrets' && c.init?.method === 'POST')!;
    const body = JSON.parse(String(post.init!.body));
    expect(body.purpose).toBe('cloudflare_token');
    expect(JSON.parse(body.value)).toEqual({ apiToken: TOKEN, accountId: ACCOUNT });
    expect(calls.some((c) => c.url === `/api/secrets/${STORED.id}/verify`)).toBe(true);
    expect(host.textContent).toContain('Verified: account token, active.');
  });

  it('shows only masked metadata for a stored token', async () => {
    installFetch({ stored: true });
    await mount();
    const panel = host.querySelector('[data-testid="cloudflare-credential"]')!;
    expect(panel.textContent).toContain('0123…cdef');
    expect(panel.textContent).toContain('…0000');
    expect(host.textContent).not.toContain(TOKEN);
    expect(host.querySelector('input[aria-label="Cloudflare API token"]')).toBeNull();
  });
});

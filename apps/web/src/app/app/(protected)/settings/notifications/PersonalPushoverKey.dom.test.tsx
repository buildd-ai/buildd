/**
 * Your Pushover key, mounted in happy-dom with a stubbed /api/me/pushover.
 * Covers add (shape guard, PUT body), the masked value after save, and that
 * Remove goes to the caller's own row. Fixtures are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/notifications', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: PersonalPushoverKey } = await import('./PersonalPushoverKey');
const { pushoverKeyStatus, checkPushoverKeyShape } = await import('@/lib/pushover-key-shape');

const KEY = 'uFAKEFAKEFAKEFAKEFAKEFAKEFAKE1';
let stored: null | { id: string; last4: string; health: string; lastVerifiedAt: string | null; lastVerificationError: null } = null;
const requests: Array<{ url: string; method: string; body: unknown }> = [];

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  stored = null;
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === 'PUT') {
      stored = { id: 'k1', last4: KEY.slice(-4), health: 'healthy', lastVerifiedAt: '2026-09-27T12:00:00Z', lastVerificationError: null };
      return Response.json({ key: stored });
    }
    if (method === 'DELETE') { stored = null; return Response.json({ deleted: true }); }
    return Response.json({ key: stored });
  }) as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); });

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
async function click(b: HTMLButtonElement | undefined) {
  expect(b).toBeDefined();
  await act(async () => { b!.click(); });
}
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function mount() {
  await act(async () => { root.render(<PersonalPushoverKey teamId="t-1" />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('Your Pushover key', () => {
  it('shows the channel row and an add button when no key is set', async () => {
    await mount();
    expect(host.textContent).toContain('Pushover · yours');
    expect(host.querySelector('[data-testid="provider-key-health"]')?.textContent).toBe('Not connected');
    expect(button('Add your key')).toBeDefined();
  });

  it('refuses a malformed key before any request, then saves a good one to /api/me/pushover', async () => {
    await mount();
    await click(button('Add your key'));
    const input = host.querySelector('input[type="password"]') as HTMLInputElement;
    type(input, 'not-a-key');
    expect(host.textContent).toContain('30 letters and digits');
    expect(button('Save key')?.disabled).toBe(true);

    type(input, KEY);
    await click(button('Save key'));
    const put = requests.find((r) => r.method === 'PUT');
    expect(put).toEqual({ url: '/api/me/pushover', method: 'PUT', body: { teamId: 't-1', value: KEY } });
    expect(host.textContent).toContain(`…${KEY.slice(-4)}`);
    expect(host.querySelector('[data-testid="provider-key-health"]')?.textContent).toBe('Connected');
    expect(host.textContent).not.toContain(KEY);
  });

  it('remove confirms, then deletes the caller\'s own key', async () => {
    stored = { id: 'k1', last4: 'RsGx', health: 'healthy', lastVerifiedAt: null, lastVerificationError: null };
    await mount();
    await click(button('Remove'));
    expect(host.textContent).toContain('still show in chat');
    await click(button('Confirm remove'));
    expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/me/pushover?teamId=t-1')).toBe(true);
  });
});

describe('pushover key helpers', () => {
  it('maps server health onto the card tones', () => {
    expect(pushoverKeyStatus(null)).toBeNull();
    expect(pushoverKeyStatus({ id: 'k', last4: 'ab12', health: 'revoked', lastVerifiedAt: null, lastVerificationError: 'bad' }))
      .toMatchObject({ masked: '…ab12', health: 'failing', error: 'bad', managedHere: true });
  });

  it('shape check', () => {
    expect(checkPushoverKeyShape(KEY)).toEqual({ ok: true, value: KEY });
    expect(checkPushoverKeyShape('x').ok).toBe(false);
  });
});

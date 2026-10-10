/**
 * Gateway tokens block, in happy-dom with a stubbed fetch. Fixtures are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: CloudflareGatewayTokens } = await import('./CloudflareGatewayTokens');

let tokens: unknown = { personal: null, team: null, canManageTeam: false };
const writes: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  writes.length = 0;
  tokens = { personal: null, team: null, canManageTeam: false };
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') { writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null }); return new Response('{}', { status: 200 }); }
    return new Response(JSON.stringify(tokens), { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<CloudflareGatewayTokens teamId="t" />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const within = (id: string) => host.querySelector(`[data-testid="${id}"]`)!;
const buttonIn = (id: string, label: string) => [...within(id).querySelectorAll('button')].find((b) => b.textContent === label);
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); }); };

describe('CloudflareGatewayTokens', () => {
  it('a member creates their own token; the team token is read-only for them', async () => {
    await mount();
    expect(within('gateway-token-personal-status').textContent).toBe('none');
    expect(buttonIn('gateway-token-team', 'Create')).toBeUndefined();
    await click(buttonIn('gateway-token-personal', 'Create'));
    expect(writes[0]).toEqual({ url: '/api/cloudflare/gateway-tokens', method: 'POST', body: { teamId: 't', scope: 'personal' } });
  });

  it('shows a saved token masked with its expiry, and an admin can renew the team token', async () => {
    tokens = {
      personal: { scope: 'personal', tokenHint: '…abcd', expiresOn: '2027-01-07T00:00:00Z', expired: false },
      team: { scope: 'team', tokenHint: '…wxyz', expiresOn: null, expired: true },
      canManageTeam: true,
    };
    await mount();
    expect(within('gateway-token-personal-status').textContent).toContain('…abcd · expires');
    expect(within('gateway-token-team-status').textContent).toBe('…wxyz · expired');
    await click(buttonIn('gateway-token-team', 'Renew'));
    expect(writes[0].body).toEqual({ teamId: 't', scope: 'team' });
  });
});

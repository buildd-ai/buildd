/**
 * The agent model endpoint section, in happy-dom with a stubbed fetch.
 * Fixtures are illustrative; nothing here is a real key.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/providers', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: AgentEndpointSection, parseAliasLines, aliasLines } = await import('./AgentEndpointSection');

const KEY = 'sk-agent-example-1234';
let endpoints: unknown[] = [];
let gateway: unknown = null;
const writes: Array<{ url: string; method: string; body: unknown }> = [];

const teamEndpoint = {
  id: 's-1', scope: 'team', workspaceId: null, workspaceName: null, kind: 'anthropic-compatible',
  baseUrl: 'https://litellm.example.com', authHeader: 'authorization', models: {}, last4: '1234',
  gatewayMissing: false, health: 'healthy', lastVerifiedAt: null, lastVerificationError: null,
};

beforeEach(() => {
  writes.length = 0;
  endpoints = [];
  gateway = null;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') { writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null }); return new Response('{}', { status: 200 }); }
    if (url.endsWith('/litellm-gateway')) return new Response(JSON.stringify({ gateway }), { status: 200 });
    return new Response(JSON.stringify({ endpoints }), { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(canManage = true) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<AgentEndpointSection teamId="t" canManage={canManage} workspaces={[{ id: 'ws-1', name: 'Widgets' }]} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
const setValue = async (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); }); };
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const kindRadio = (i: number) => host.querySelectorAll('input[name="agent-endpoint-kind"]')[i];

describe('AgentEndpointSection', () => {
  it('nothing set: Anthropic is the default and nothing says metered', async () => {
    await mount();
    expect(text('agent-endpoint-status')).toBe('Anthropic (default)');
    expect(host.querySelector('[data-testid="agent-endpoint-metered"]')).toBeNull();
  });

  it('an endpoint shows URL and last4 only, and says runs are metered', async () => {
    endpoints = [teamEndpoint];
    await mount();
    expect(text('agent-endpoint-status')).toBe('Anthropic-compatible URL · https://litellm.example.com · key …1234');
    expect(text('agent-endpoint-metered')).toMatch(/metered/);
    expect(text('agent-endpoint-metered')).toMatch(/not a Claude seat/);
    expect(host.textContent).not.toContain(KEY);
  });

  it('sets a custom URL with a PUT, then clears the key input', async () => {
    await mount();
    await click(button('Change'));
    await click(kindRadio(3));
    await setValue(host.querySelector('#agent-endpoint-url') as HTMLInputElement, 'https://litellm.example.com');
    await setValue(host.querySelector('#agent-endpoint-key') as HTMLInputElement, KEY);
    await click(host.querySelectorAll('input[name="agent-endpoint-header"]')[1]);
    await setValue(host.querySelector('#agent-endpoint-aliases') as HTMLTextAreaElement, 'claude-sonnet-5 = team-sonnet');
    await click(button('Save'));
    expect(writes[0]).toEqual({
      url: '/api/teams/t/agent-endpoint',
      method: 'PUT',
      body: { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: KEY, authHeader: 'x-api-key', models: { 'claude-sonnet-5': 'team-sonnet' } },
    });
    expect(host.querySelector('#agent-endpoint-key')).toBeNull();
  });

  it('the gateway option is disabled without a gateway, and sends only the kind with one', async () => {
    await mount();
    await click(button('Change'));
    expect((kindRadio(1) as HTMLInputElement).disabled).toBe(true);
    act(() => root.unmount()); host.remove();
    gateway = { baseURL: 'https://litellm.example.com/v1', last4: 'abcd' };
    await mount();
    await click(button('Change'));
    await act(async () => { host.querySelector<HTMLElement>('#agent-endpoint-scope')!.click(); });
    const ws = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes('Widgets'));
    await act(async () => { ws!.click(); });
    await click(kindRadio(1));
    await click(button('Save'));
    expect(writes[0]).toEqual({ url: '/api/teams/t/agent-endpoint', method: 'PUT', body: { kind: 'gateway', workspaceId: 'ws-1' } });
  });

  it('Verify posts to the secret verify route; Remove deletes the scope', async () => {
    endpoints = [teamEndpoint, { ...teamEndpoint, id: 's-2', scope: 'workspace', workspaceId: 'ws-1', workspaceName: 'Widgets' }];
    await mount();
    const verifies = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Verify');
    await click(verifies[0]);
    expect(writes.at(-1)).toMatchObject({ url: '/api/secrets/s-2/verify', method: 'POST' });
    const removes = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Remove');
    await click(removes[0]);
    expect(writes.at(-1)).toMatchObject({ url: '/api/teams/t/agent-endpoint?workspaceId=ws-1', method: 'DELETE' });
    await click(removes[1]);
    expect(writes.at(-1)).toMatchObject({ url: '/api/teams/t/agent-endpoint', method: 'DELETE' });
  });

  it('is read-only for a member', async () => {
    endpoints = [teamEndpoint];
    await mount(false);
    expect(button('Change')).toBeUndefined();
    expect(button('Verify')).toBeUndefined();
    expect(button('Remove')).toBeUndefined();
  });
});

describe('alias lines', () => {
  it('parses one alias per line and round-trips', () => {
    expect(parseAliasLines('a = b\n\n# note\nc=d')).toEqual({ ok: true, models: { a: 'b', c: 'd' } });
    expect(aliasLines({ a: 'b' })).toBe('a = b');
    expect(parseAliasLines('no-equals').ok).toBe(false);
    expect(parseAliasLines('a = b c').ok).toBe(false);
  });
});

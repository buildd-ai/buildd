/**
 * The LiteLLM gateway and decision-model sections, in happy-dom with a stubbed
 * fetch. Fixtures are illustrative; nothing here is a real key.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/providers', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: GatewayAndDecisionModel } = await import('./GatewayAndDecisionModel');
const { describeControls } = await import('../_lib/form-controls');

let gateway: unknown = null;
let decisionModel: unknown = null;
const writes: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  writes.length = 0;
  gateway = null;
  decisionModel = null;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') { writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null }); return new Response('{}', { status: 200 }); }
    if (url.endsWith('/litellm-gateway')) return new Response(JSON.stringify({ gateway }), { status: 200 });
    return new Response(JSON.stringify({ team: { decisionModel } }), { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(canManage = true) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<GatewayAndDecisionModel teamId="t" canManage={canManage} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
const setValue = async (el: HTMLInputElement, v: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); }); };
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);

describe('GatewayAndDecisionModel', () => {
  it('shows a connected gateway by URL and last4 only, and Jev as the default decision model', async () => {
    gateway = { baseURL: 'https://litellm.example.test/v1', last4: 'abcd', health: 'healthy', lastVerificationError: null };
    await mount();
    expect(text('litellm-gateway-status')).toBe('https://litellm.example.test/v1 · key …abcd');
    expect(text('decision-model-current')).toBe('Jev (default)');
  });

  it('connects a gateway with a PUT of the URL and key', async () => {
    await mount();
    await click(button('Connect'));
    await setValue(host.querySelector('#gateway-url') as HTMLInputElement, 'https://litellm.example.test/v1');
    await setValue(host.querySelector('#gateway-key') as HTMLInputElement, 'sk-lite-example');
    await click(button('Save'));
    expect(writes[0]).toEqual({ url: '/api/teams/t/litellm-gateway', method: 'PUT', body: { baseUrl: 'https://litellm.example.test/v1', apiKey: 'sk-lite-example' } });
  });

  it('saves another decision model via the gateway, and back to Jev with null', async () => {
    gateway = { baseURL: 'https://litellm.example.test/v1', last4: 'abcd', health: 'healthy', lastVerificationError: null };
    await mount();
    const radios = host.querySelectorAll('input[name="decision-model"]');
    await click(radios[1]);
    await setValue(host.querySelector('#decision-model-id') as HTMLInputElement, 'qwen3-8b');
    await click([...host.querySelectorAll('[data-testid="decision-model"] button')].find((b) => b.textContent === 'Save'));
    expect(writes.at(-1)).toEqual({ url: '/api/teams/t', method: 'PATCH', body: { decisionModel: { endpoint: 'chat', model: 'qwen3-8b', via: 'litellm' } } });
    await click(radios[0]);
    expect(writes.at(-1)).toEqual({ url: '/api/teams/t', method: 'PATCH', body: { decisionModel: null } });
  });

  it('saves Clef via Cloudflare as a System One model, defaulting to Clef', async () => {
    await mount();
    await click(host.querySelectorAll('input[name="decision-model"]')[1]);
    const cf = [...host.querySelectorAll('input[name="decision-via"]')].find((r) => r.parentElement?.textContent === 'Cloudflare');
    await click(cf);
    const trigger = host.querySelector('[data-testid="decision-model-cf"]');
    expect(trigger?.textContent).toContain('Clef');
    await click(trigger);
    await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes('Clef Flash')));
    await click([...host.querySelectorAll('[data-testid="decision-model"] button')].find((b) => b.textContent === 'Save'));
    expect(writes.at(-1)).toEqual({ url: '/api/teams/t', method: 'PATCH', body: { decisionModel: { endpoint: 'systemone', model: 'clef-flash', via: 'cloudflare' } } });
  });

  it('names Cloudflare in the current model', async () => {
    decisionModel = { endpoint: 'systemone', model: 'clef', via: 'cloudflare' };
    await mount(false);
    expect(text('decision-model-current')).toBe('clef via Cloudflare');
  });

  it('is read-only for a member', async () => {
    decisionModel = { endpoint: 'chat', model: 'qwen3-8b', via: 'openrouter' };
    await mount(false);
    expect(text('decision-model-current')).toBe('qwen3-8b via OpenRouter');
    expect(button('Connect')).toBeUndefined();
    expect(host.querySelector('input[name="decision-model"]')).toBeNull();
  });

  it('a member reads a connected gateway and the decision model with no control at all', async () => {
    gateway = { baseURL: 'https://litellm.example.com/v1', last4: 'abcd', health: 'healthy', lastVerificationError: null };
    decisionModel = { endpoint: 'chat', model: 'qwen3-8b', via: 'litellm' };
    await mount(false);
    expect(text('litellm-gateway-status')).toContain('https://litellm.example.com/v1');
    expect(text('decision-model-current')).toBe('qwen3-8b via LiteLLM');
    expect(describeControls(host)).toEqual([]);
    expect(host.textContent).not.toMatch(/Admins can change|Only a team owner|can change this/);
  });
});

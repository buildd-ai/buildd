/**
 * Profile's "Your keys" row: what chat runs on for you, and the one link to
 * manage your own keys on Models. Mounted in happy-dom with a stubbed fetch.
 * Fixtures are illustrative; nothing here is a real key.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/account', width: 390, height: 844 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  usePathname: () => '/app/settings/account',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: PersonalProviderKeys } = await import('./PersonalProviderKeys');

type Provider = 'openrouter' | 'anthropic' | 'openai' | 'litellm';
const key = (provider: Provider, scope: 'team' | 'user', last4 = '91c0') => ({
  id: `${provider}-${scope}`, provider, scope, last4, health: 'healthy', lastVerifiedAt: null,
  lastVerificationError: null, updatedAt: '2026-09-26T10:00:00Z', source: 'inference_key',
});
const card = (provider: Provider, team: boolean, mine: false | string = false) => ({
  provider, team: team ? key(provider, 'team') : null, mine: mine ? key(provider, 'user', mine) : null, membersWithOwnKey: null,
});

let body: Record<string, unknown> = {};
const calls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  body = { teamId: 't', canManageTeamKeys: false, keyPolicy: 'team', providers: [], chatUses: null };
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === 'PUT') {
      const b = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ key: key(b.provider, 'user', b.value.slice(-4)) }), { status: 200 });
    }
    if (method === 'DELETE') return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    if (method === 'POST') return new Response(JSON.stringify({ key: key(JSON.parse(String(init!.body)).provider, 'user') }), { status: 200 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<PersonalProviderKeys teamId="t" isAdmin={false} />); });
  await flush();
}
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }

const line = () => host.querySelector('[data-testid="chat-key-line"]')?.textContent;

describe('the chat line names the provider you can bring a key for', () => {
  it('only Anthropic enabled: asks for an Anthropic key', async () => {
    body = { ...body, keyPolicy: 'own', providers: [card('openrouter', false), card('anthropic', true), card('openai', false)] };
    await mount();
    expect(line()).toBe('Add your Anthropic key');
  });

  it('several enabled: asks for your own key', async () => {
    body = { ...body, keyPolicy: 'own', providers: [card('openrouter', false), card('anthropic', true), card('openai', true)] };
    await mount();
    expect(line()).toBe('Add your own key');
  });

  it('never names a provider whose route takes no personal keys', async () => {
    body = { ...body, keyPolicy: 'own', providers: [card('litellm', true), card('anthropic', true)] };
    await mount();
    expect(line()).toBe('Add your Anthropic key');
    expect(host.textContent).not.toContain('LiteLLM');
  });
});

describe('Chat uses: the provider and scope chat actually resolves to', () => {
  it('names the resolved provider, not the first key in display order', async () => {
    // You hold an OpenRouter key, but the resolver serves the tier's vendor
    // from the team's Anthropic key.
    body = { ...body, keyPolicy: 'team_or_own', providers: [card('openrouter', false, 'cd34'), card('anthropic', true)], chatUses: { provider: 'anthropic', scope: 'team' } };
    await mount();
    expect(line()).toBe('Anthropic · team key');
    expect(host.querySelector('[data-testid="chat-key-row"]')?.textContent).toContain('Chat uses');
  });

  it('says your key when chat runs on it', async () => {
    body = { ...body, keyPolicy: 'team_or_own', providers: [card('anthropic', true, 'ab12')], chatUses: { provider: 'anthropic', scope: 'user' } };
    await mount();
    expect(line()).toBe('Anthropic · your key');
  });

  it('with nothing resolving, a member is told to ask an admin', async () => {
    await mount();
    expect(line()).toBe('Not set up · ask an admin');
    expect(host.textContent).not.toContain('not connected');
  });
});

describe('one row, managed on Models', () => {
  it('is a single row with one Manage link to your keys on Models, and no key controls here', async () => {
    body = { ...body, keyPolicy: 'own', providers: [card('anthropic', true, 'ab12')], chatUses: { provider: 'anthropic', scope: 'user' } };
    await mount();
    const links = [...host.querySelectorAll('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Manage', '/app/settings/keys']]);
    expect(host.textContent).toContain('Your keys');
    expect(host.querySelector('input')).toBeNull();
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelector('[data-testid^="provider-key-"]')).toBeNull();
  });

  it('only reads: no write calls', async () => {
    await mount();
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

/**
 * The Account chat row and your own provider keys, mounted in happy-dom with a
 * stubbed fetch. Fixtures are illustrative; nothing here is a real key.
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
const offeredCards = () => [...host.querySelectorAll('[data-testid^="provider-key-"][data-configured]')].map((e) => e.getAttribute('data-testid')!.replace('provider-key-', ''));
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
async function click(b: HTMLButtonElement | undefined) {
  expect(b).toBeDefined();
  await act(async () => { b!.click(); });
  await flush();
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('which providers you can bring a key for', () => {
  it('only Anthropic enabled: one Anthropic card, and the line asks for an Anthropic key', async () => {
    body = { ...body, keyPolicy: 'own', providers: [card('openrouter', false), card('anthropic', true), card('openai', false)] };
    await mount();
    expect(offeredCards()).toEqual(['anthropic']);
    expect(line()).toBe('Add your Anthropic key');
  });

  it('only OpenAI enabled: one OpenAI card', async () => {
    body = { ...body, keyPolicy: 'team_or_own', providers: [card('openrouter', false), card('anthropic', false), card('openai', true)], chatUses: { provider: 'openai', scope: 'team' } };
    await mount();
    expect(offeredCards()).toEqual(['openai']);
    expect(line()).toBe('OpenAI · team key');
  });

  it('only OpenRouter enabled: one OpenRouter card', async () => {
    body = { ...body, keyPolicy: 'team_or_own', providers: [card('openrouter', true), card('anthropic', false), card('openai', false)], chatUses: { provider: 'openrouter', scope: 'team' } };
    await mount();
    expect(offeredCards()).toEqual(['openrouter']);
  });

  it('several enabled: offers exactly those', async () => {
    body = { ...body, keyPolicy: 'own', providers: [card('openrouter', false), card('anthropic', true), card('openai', true)] };
    await mount();
    expect(offeredCards()).toEqual(['anthropic', 'openai']);
    expect(line()).toBe('Add your own key');
  });

  it('never shows a provider whose route takes no personal keys', async () => {
    body = { ...body, keyPolicy: 'own', providers: [card('litellm', true), card('anthropic', true)] };
    await mount();
    expect(offeredCards()).toEqual(['anthropic']);
    expect(host.textContent).not.toContain('LiteLLM');
  });

  it('has no OpenRouter-only connect button on the personal path', async () => {
    body = { ...body, keyPolicy: 'own', providers: [card('anthropic', true)] };
    await mount();
    expect(host.querySelector('[data-testid="connect-openrouter"]')).toBeNull();
    expect(host.textContent).not.toMatch(/OpenRouter/);
  });
});

describe('the team key policy', () => {
  it("'team': one line, no personal controls, even with a key of your own on file", async () => {
    body = { ...body, keyPolicy: 'team', providers: [card('anthropic', true, 'ab12')], chatUses: { provider: 'anthropic', scope: 'team' } };
    await mount();
    expect(line()).toBe('Anthropic · team key');
    expect(offeredCards()).toEqual([]);
    expect(host.querySelector('details')).toBeNull();
    expect(host.textContent).not.toContain('Use my own key');
  });

  it("'team_or_own': the cards sit behind a quiet disclosure", async () => {
    body = { ...body, keyPolicy: 'team_or_own', providers: [card('anthropic', true)], chatUses: { provider: 'anthropic', scope: 'team' } };
    await mount();
    const details = host.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain('Use my own key');
    expect([...details.querySelectorAll('[data-testid^="provider-key-"][data-configured]')].map((e) => e.getAttribute('data-testid'))).toEqual(['provider-key-anthropic']);
  });

  it("'team_or_own' with your own key: open, and the line says your key", async () => {
    body = { ...body, keyPolicy: 'team_or_own', providers: [card('anthropic', true, 'ab12')], chatUses: { provider: 'anthropic', scope: 'user' } };
    await mount();
    expect(host.querySelector('details')!.open).toBe(true);
    expect(line()).toBe('Anthropic · your key');
  });

  it('where personal keys are allowed, says they run your agent tasks too, not chat only, and links to Mine', async () => {
    body = { ...body, keyPolicy: 'team_or_own', providers: [card('anthropic', true)], chatUses: { provider: 'anthropic', scope: 'team' } };
    await mount();
    const note = host.querySelector('[data-testid="own-key-scope"]')!;
    expect(note.textContent).toContain('agent tasks you start');
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/app/settings/providers?scope=mine');
    expect(host.textContent).not.toMatch(/chat only|for chat\b/i);
  });

  it("'own': the cards are in the open, no disclosure", async () => {
    body = { ...body, keyPolicy: 'own', providers: [card('openai', true)] };
    await mount();
    expect(host.querySelector('details')).toBeNull();
    expect(offeredCards()).toEqual(['openai']);
  });

  it("'own' with no provider enabled by the team: every personal-key provider", async () => {
    body = { ...body, keyPolicy: 'own', providers: [card('openrouter', false), card('anthropic', false), card('openai', false)] };
    await mount();
    expect(offeredCards()).toEqual(['openrouter', 'anthropic', 'openai']);
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

  it('is one line that links to Model providers', async () => {
    body = { ...body, providers: [card('openai', true)], chatUses: { provider: 'openai', scope: 'team' } };
    await mount();
    const row = host.querySelector('[data-testid="chat-key-row"]')!;
    expect(row.tagName).toBe('A');
    expect(row.getAttribute('href')).toBe('/app/settings/providers');
    expect(host.querySelector('h2')).toBeNull();
  });

  it('with nothing resolving, a member is told to ask an admin', async () => {
    await mount();
    expect(line()).toBe('Not set up · ask an admin');
    expect(host.textContent).not.toContain('not connected');
  });
});

describe('your key: masked, tested, replaced and removed through the shared API', () => {
  beforeEach(() => {
    body = { ...body, keyPolicy: 'own', providers: [card('anthropic', true, 'ab12')], chatUses: { provider: 'anthropic', scope: 'user' } };
  });

  it('shows only the last four characters', async () => {
    await mount();
    const c = host.querySelector('[data-testid="provider-key-anthropic"]')!;
    expect(c.textContent).toContain('…ab12');
    expect(c.textContent).toContain('Your key');
  });

  it('Test re-checks your key, at your scope', async () => {
    await mount();
    await click(button(host, 'Test key'));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/inference-keys/verify');
    expect(post.body).toEqual({ teamId: 't', provider: 'anthropic', scope: 'user' });
    expect(host.textContent).toContain('Anthropic accepted the key.');
  });

  it('Replace sends the new key at your scope and never leaves it in the DOM', async () => {
    await mount();
    await click(button(host, 'Replace'));
    const input = host.querySelector('input[type="password"]') as HTMLInputElement;
    const secret = 'sk-ant-api03-example-not-a-real-key-ef56';
    await type(input, secret);
    await click(button(host, 'Replace key'));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({ teamId: 't', provider: 'anthropic', scope: 'user', value: secret });
    expect(host.innerHTML).not.toContain(secret);
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(1);
  });

  it('Remove deletes your key only, after a confirm', async () => {
    await mount();
    await click(button(host, 'Remove'));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await click(button(host, 'Confirm remove'));
    const del = calls.find((c) => c.method === 'DELETE')!;
    const qs = new URL(del.url, 'http://localhost').searchParams;
    expect(Object.fromEntries(qs)).toEqual({ teamId: 't', provider: 'anthropic', scope: 'user' });
  });
});

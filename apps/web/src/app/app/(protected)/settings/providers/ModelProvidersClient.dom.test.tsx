/**
 * Model providers and the Account chat row, mounted in happy-dom with a stubbed
 * fetch. Fixtures are illustrative; nothing here is a real key.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/providers', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  usePathname: () => '/app/settings/providers',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ModelProvidersClient } = await import('./ModelProvidersClient');
const { default: PersonalProviderKeys } = await import('../account/PersonalProviderKeys');

const teamKey = { id: 'k1', provider: 'openrouter', scope: 'team', last4: '91c0', health: 'healthy', lastVerifiedAt: '2026-09-26T10:00:00Z', lastVerificationError: null, updatedAt: '2026-09-26T10:00:00Z', source: 'inference_key' };
let body: Record<string, unknown> = {};
const patches: unknown[] = [];

beforeEach(() => {
  patches.length = 0;
  body = { teamId: 't', canManageTeamKeys: true, keyPolicy: 'team', chatDisabled: false, providers: [] };
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { patches.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 }); }
    if (String(url).startsWith('/api/inference-keys')) return new Response(JSON.stringify(body), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(node); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('ModelProvidersClient', () => {
  it('lists OpenRouter first, marked recommended', async () => {
    await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: false, reason: 'no_key' }} />);
    const ids = [...host.querySelectorAll('[data-testid^="provider-key-"][data-configured]')].map((e) => e.getAttribute('data-testid'));
    expect(ids).toEqual(['provider-key-openrouter', 'provider-key-anthropic', 'provider-key-openai']);
    expect(host.querySelector('[data-testid="provider-key-openrouter"]')?.textContent).toContain('recommended');
  });

  it('reports the real reason, not "turn on chat"', async () => {
    await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: false, reason: 'no_key' }} />);
    expect(host.querySelector('[data-testid="chat-status"]')?.textContent).toContain('Chat starts once you connect a provider below.');
    expect(host.textContent).not.toContain('Turn on chat');
    expect(host.textContent).not.toContain('Which key a chat turn uses');
  });

  it('an admin sets "everyone brings their own key"', async () => {
    await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: false, reason: 'no_key' }} />);
    const radios = host.querySelectorAll('input[name="key-policy"]');
    await act(async () => { (radios[1] as HTMLInputElement).click(); });
    expect(patches).toEqual([{ inferenceKeyPolicy: 'own' }]);
  });

  it('a member sees the policy as one line, with no controls', async () => {
    body = { ...body, canManageTeamKeys: false };
    await mount(<ModelProvidersClient teamId="t" isAdmin={false} availability={{ available: false, reason: 'no_key' }} />);
    expect(host.querySelector('input[name="key-policy"]')).toBeNull();
    expect(host.querySelector('[data-testid="key-policy"]')?.textContent).toBe('Chat uses the team key.');
  });
});

describe('Account chat row', () => {
  it('a member under the team key sees one line and no provider cards', async () => {
    body = { ...body, canManageTeamKeys: false, providers: [{ provider: 'openrouter', team: teamKey, mine: null, membersWithOwnKey: null }] };
    await mount(<PersonalProviderKeys teamId="t" isAdmin={false} />);
    expect(host.querySelector('[data-testid="chat-key-line"]')?.textContent).toBe('OpenRouter · team key');
    expect(host.querySelectorAll('[data-testid^="provider-key-"][data-configured]').length).toBe(0);
    expect(host.textContent).not.toContain('Use my own key instead');
  });

  it('with no team key, a member is told to ask an admin', async () => {
    body = { ...body, canManageTeamKeys: false };
    await mount(<PersonalProviderKeys teamId="t" isAdmin={false} />);
    expect(host.querySelector('[data-testid="chat-key-line"]')?.textContent).toBe('Not set up yet · ask an admin');
    expect(host.textContent).not.toContain('not connected');
  });

  it('when own keys are allowed, they sit behind a quiet disclosure', async () => {
    body = { ...body, keyPolicy: 'team_or_own', providers: [{ provider: 'openrouter', team: teamKey, mine: null, membersWithOwnKey: null }] };
    await mount(<PersonalProviderKeys teamId="t" isAdmin={false} />);
    const details = host.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain('Use my own key instead');
  });

  it('when everyone brings their own key, leads with Connect OpenRouter and tucks the paste field away', async () => {
    body = { ...body, keyPolicy: 'own' };
    await mount(<PersonalProviderKeys teamId="t" isAdmin={false} />);
    expect(host.querySelector('[data-testid="chat-key-line"]')?.textContent).toBe('Add your OpenRouter key to use chat');
    expect(host.querySelector('[data-testid="connect-openrouter"]')?.getAttribute('href')).toContain('scope=user');
    const details = host.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain('Paste a key instead');
    const cards = [...details.querySelectorAll('[data-testid^="provider-key-"][data-configured]')].map((e) => e.getAttribute('data-testid'));
    expect(cards).toEqual(['provider-key-openrouter']);
  });
});

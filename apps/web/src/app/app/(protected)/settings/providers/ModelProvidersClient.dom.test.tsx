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
const puts: { provider: string; value: string }[] = [];
const keyOf = (provider: string, last4: string, health = 'healthy') => ({ ...teamKey, id: `k-${provider}`, provider, last4, health });
const card = (provider: string, team: unknown, membersWithOwnKey: number | null = 0) => ({ provider, team, mine: null, membersWithOwnKey });
const buttonLabels = (el: Element) => [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
// Shaped like a real key so a leak would be obvious; it is not one.
const PASTED = 'sk-ant-api03-illustrative-not-a-real-key-0000';

beforeEach(() => {
  patches.length = 0;
  puts.length = 0;
  body = { teamId: 't', canManageTeamKeys: true, keyPolicy: 'team', providers: [] };
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { patches.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 }); }
    if (init?.method === 'PUT') {
      const sent = JSON.parse(String(init.body)) as { provider: string; value: string };
      puts.push(sent);
      const key = keyOf(sent.provider, sent.value.slice(-4));
      body = { ...body, providers: [...(body.providers as unknown[]), card(sent.provider, key)] };
      return new Response(JSON.stringify({ key }), { status: 200 });
    }
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
  it('lists every provider, OpenRouter first with a recommended hint', async () => {
    await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: false, reason: 'no_key' }} />);
    const ids = [...host.querySelectorAll('[data-testid^="provider-key-"][data-configured]')].map((e) => e.getAttribute('data-testid'));
    expect(ids).toEqual(['provider-key-openrouter', 'provider-key-anthropic', 'provider-key-openai']);
    expect(host.querySelector('[data-testid="provider-key-openrouter"]')?.textContent).toContain('recommended');
  });

  it('reports the real reason, not "turn on chat"', async () => {
    await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: false, reason: 'no_key' }} />);
    expect(host.querySelector('[data-testid="chat-status"]')?.textContent).toContain('Chat needs a key. Add one below.');
    expect(host.textContent).not.toContain('Turn on chat');
    expect(host.textContent).not.toContain('Which key a chat turn uses');
  });

  it('gives every empty card the same Add team key button; Connect OpenRouter is an extra, not a replacement', async () => {
    await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: false, reason: 'no_key' }} />);
    for (const id of ['openrouter', 'anthropic', 'openai']) {
      const card = host.querySelector(`[data-testid="provider-key-${id}"]`)!;
      expect(buttonLabels(card)).toEqual(['Add team key']);
    }
    expect(host.querySelectorAll('[data-testid="connect-openrouter"]').length).toBe(1);
    expect(host.querySelector('[data-testid="provider-key-openrouter"] [data-testid="connect-openrouter"]')).not.toBeNull();
  });

  it('has no stacked explanation paragraphs', async () => {
    await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: false, reason: 'no_key' }} />);
    expect(host.querySelector('[data-testid="key-unlocks"]')).toBeNull();
  });

  it('draws the "Whose key" radios as square custom controls, not native circles', async () => {
    await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: false, reason: 'no_key' }} />);
    const radios = [...host.querySelectorAll('input[name="key-policy"]')] as HTMLInputElement[];
    expect(radios.length).toBe(2);
    for (const r of radios) {
      expect(r.className).toContain('appearance-none');
      expect(r.className).not.toMatch(/rounded/);
    }
    const box = host.querySelector('[data-testid="key-policy"] input[type="checkbox"]') as HTMLInputElement;
    expect(box.className).toContain('appearance-none');
  });

  it('names the options plainly: Team key / Each person\'s own key', async () => {
    await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: false, reason: 'no_key' }} />);
    const policy = host.querySelector('[data-testid="key-policy"]')!;
    expect(policy.textContent).toContain('Team key');
    expect(policy.textContent).toContain("Each person's own key");
    expect(policy.textContent).not.toMatch(/who pays|chat/i);
  });

  it('an admin sets "each person\'s own key"', async () => {
    await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: false, reason: 'no_key' }} />);
    const radios = host.querySelectorAll('input[name="key-policy"]');
    await act(async () => { (radios[1] as HTMLInputElement).click(); });
    expect(patches).toEqual([{ inferenceKeyPolicy: 'own' }]);
  });

  it('a member sees the policy as one line, with no controls', async () => {
    body = { ...body, canManageTeamKeys: false };
    await mount(<ModelProvidersClient teamId="t" isAdmin={false} availability={{ available: false, reason: 'no_key' }} />);
    expect(host.querySelector('input[name="key-policy"]')).toBeNull();
    expect(host.querySelector('[data-testid="key-policy"]')?.textContent).toBe('Team key');
  });
});

const VIEWPORTS = [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 800 }] as const;

for (const vp of VIEWPORTS) {
  describe(`ModelProvidersClient at ${vp.name} width`, () => {
    beforeEach(() => {
      (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport(vp);
    });

    it('a team with only an Anthropic key: that card is configured, the others offer the same Add', async () => {
      body = { ...body, providers: [card('anthropic', keyOf('anthropic', '4f2a'))] };
      await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: true, reason: null }} />);
      expect(window.innerWidth).toBe(vp.width);
      expect(host.querySelector('[data-testid="chat-status-text"]')?.textContent).toBe('Chat uses: Anthropic · team key');
      const anthropic = host.querySelector('[data-testid="provider-key-anthropic"]')!;
      expect(anthropic.getAttribute('data-configured')).toBe('true');
      expect(anthropic.textContent).toContain('…4f2a');
      expect(buttonLabels(anthropic)).toEqual(['Test key', 'Replace', 'Remove']);
      for (const id of ['openrouter', 'openai']) {
        const c = host.querySelector(`[data-testid="provider-key-${id}"]`)!;
        expect(c.getAttribute('data-configured')).toBe('false');
        expect(buttonLabels(c)).toEqual(['Add team key']);
      }
    });

    it('a team with only an OpenAI key that cannot serve chat\'s default model is told so, not "add a key"', async () => {
      body = { ...body, providers: [card('openai', keyOf('openai', '7d1e'))] };
      await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: false, reason: 'no_key' }} />);
      const status = host.querySelector('[data-testid="chat-status"]')!;
      expect(status.textContent).toContain('OpenAI');
      expect(status.textContent).not.toContain('Add one below');
      expect(status.querySelector('a')?.getAttribute('href')).toBe('/app/settings/models');
    });

    it('a mixed team: every configured card behaves the same, and the status names all of them', async () => {
      body = { ...body, providers: [
        card('openrouter', keyOf('openrouter', '91c0')),
        card('anthropic', keyOf('anthropic', '4f2a')),
        card('openai', keyOf('openai', '7d1e', 'unknown')),
      ] };
      await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: true, reason: null }} />);
      expect(host.querySelector('[data-testid="chat-status-text"]')?.textContent).toBe('Chat uses: OpenRouter, Anthropic, OpenAI · team keys');
      for (const id of ['openrouter', 'anthropic', 'openai']) {
        expect(buttonLabels(host.querySelector(`[data-testid="provider-key-${id}"]`)!)).toEqual(['Test key', 'Replace', 'Remove']);
      }
      expect(host.querySelector('[data-testid="connect-openrouter"]')).toBeNull();
      expect(host.querySelector('[data-testid="provider-key-openai"] [data-testid="provider-key-health"]')?.textContent).toBe('not tested');
    });

    it('two providers configured, one empty', async () => {
      body = { ...body, providers: [card('anthropic', keyOf('anthropic', '4f2a')), card('openai', keyOf('openai', '7d1e'))] };
      await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: true, reason: null }} />);
      expect(host.querySelector('[data-testid="chat-status-text"]')?.textContent).toBe('Chat uses: Anthropic, OpenAI · team keys');
      expect([...host.querySelectorAll('[data-configured="true"]')].map((e) => e.getAttribute('data-testid')))
        .toEqual(['provider-key-anthropic', 'provider-key-openai']);
    });

    it('a member sees every card read-only: masked keys and health, no controls', async () => {
      body = { ...body, canManageTeamKeys: false, providers: [card('anthropic', keyOf('anthropic', '4f2a'), null), card('openai', keyOf('openai', '7d1e'), null)] };
      await mount(<ModelProvidersClient teamId="t" isAdmin={false} availability={{ available: true, reason: null }} />);
      for (const id of ['openrouter', 'anthropic', 'openai']) {
        const c = host.querySelector(`[data-testid="provider-key-${id}"]`)!;
        expect(c.querySelectorAll('button, input').length).toBe(0);
      }
      expect(host.querySelector('[data-testid="connect-openrouter"]')).toBeNull();
      expect(host.textContent).toContain('…4f2a');
      expect(host.textContent).toContain('Only a team owner or admin can change team keys.');
      expect(host.querySelector('input[name="key-policy"]')).toBeNull();
    });

    it('a pasted key is sent once and never stays in the DOM', async () => {
      await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: false, reason: 'no_key' }} />);
      const anthropic = () => host.querySelector('[data-testid="provider-key-anthropic"]')!;
      await act(async () => { (anthropic().querySelector('button') as HTMLButtonElement).click(); });
      const input = anthropic().querySelector('input') as HTMLInputElement;
      expect(input.type).toBe('password');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => { setter.call(input, PASTED); input.dispatchEvent(new Event('input', { bubbles: true })); });
      const save = [...anthropic().querySelectorAll('button')].find((b) => b.textContent === 'Save key') as HTMLButtonElement;
      await act(async () => { save.click(); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(puts).toEqual([{ teamId: 't', provider: 'anthropic', scope: 'team', value: PASTED } as never]);
      expect(anthropic().getAttribute('data-configured')).toBe('true');
      expect(anthropic().textContent).toContain('…0000');
      expect(host.innerHTML).not.toContain(PASTED);
      expect(host.innerHTML).not.toContain('illustrative-not-a-real-key');
      for (const i of host.querySelectorAll('input')) expect((i as HTMLInputElement).value).not.toContain('illustrative');
    });

    it('keeps the team / team_or_own / own control', async () => {
      body = { ...body, keyPolicy: 'team_or_own', providers: [card('openai', keyOf('openai', '7d1e'))] };
      await mount(<ModelProvidersClient teamId="t" isAdmin availability={{ available: true, reason: null }} />);
      const box = host.querySelector('[data-testid="key-policy"] input[type="checkbox"]') as HTMLInputElement;
      expect(box.checked).toBe(true);
      await act(async () => { box.click(); });
      expect(patches).toEqual([{ inferenceKeyPolicy: 'team' }]);
      const radios = host.querySelectorAll('input[name="key-policy"]');
      await act(async () => { (radios[1] as HTMLInputElement).click(); });
      expect(patches.at(-1)).toEqual({ inferenceKeyPolicy: 'own' });
    });
  });
}

describe('Account chat row', () => {
  it('a member under the team key sees one line and no provider cards', async () => {
    body = { ...body, canManageTeamKeys: false, providers: [{ provider: 'openrouter', team: teamKey, mine: null, membersWithOwnKey: null }] };
    await mount(<PersonalProviderKeys teamId="t" isAdmin={false} />);
    expect(host.querySelector('[data-testid="chat-key-line"]')?.textContent).toBe('OpenRouter · team key');
    expect(host.querySelectorAll('[data-testid^="provider-key-"][data-configured]').length).toBe(0);
    expect(host.textContent).not.toContain('Use my own key instead');
  });

  it('is one line that links to Model providers, with no section of its own', async () => {
    body = { ...body, canManageTeamKeys: false, providers: [{ provider: 'anthropic', team: { ...teamKey, provider: 'anthropic' }, mine: null, membersWithOwnKey: null }] };
    await mount(<PersonalProviderKeys teamId="t" isAdmin={false} />);
    const row = host.querySelector('[data-testid="chat-key-row"]')!;
    expect(row.tagName).toBe('A');
    expect(row.getAttribute('href')).toBe('/app/settings/providers');
    expect(row.textContent).toContain('Chat uses');
    expect(row.textContent).toContain('Anthropic · team key');
    expect(host.querySelector('h2')).toBeNull();
    expect(host.textContent).not.toMatch(/interactive ai/i);
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
    expect(host.querySelector('[data-testid="chat-key-line"]')?.textContent).toBe('Add your OpenRouter key');
    expect(host.querySelector('[data-testid="connect-openrouter"]')?.getAttribute('href')).toContain('scope=user');
    const details = host.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain('Paste a key instead');
    const cards = [...details.querySelectorAll('[data-testid^="provider-key-"][data-configured]')].map((e) => e.getAttribute('data-testid'));
    expect(cards).toEqual(['provider-key-openrouter']);
  });
});

/**
 * Settings → Providers, mounted in happy-dom with a stubbed fetch over
 * `/api/providers`. Listings are built from the real registry
 * (providers-fixture-data), so a registry change reaches these tests.
 * Fixtures are illustrative; nothing here is a real key.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/providers', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let search = new URLSearchParams();
mock.module('next/navigation', () => ({
  usePathname: () => '/app/settings/providers',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => search,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ModelProvidersClient } = await import('./ModelProvidersClient');
const { fixturePolicy, fixtureResponse } = await import('../../../dev/fixtures/providers-fixture-data');
type FixtureOpts = Parameters<typeof fixtureResponse>[0];

// Shaped like a real key so a leak would be obvious; it is not one.
const PASTED = 'sk-ant-api03-illustrative-not-a-real-key-0000';
const WORKSPACES = [{ id: 'ws-a', name: 'Workspace A' }, { id: 'ws-b', name: 'Workspace B' }];

let opts: FixtureOpts = {};
const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];

beforeEach(() => {
  search = new URLSearchParams();
  opts = {};
  calls.length = 0;
  globalThis.fetch = mock(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ url: String(input), method, body });
    if (url.pathname === '/api/providers/explain') {
      return Response.json({
        surface: url.searchParams.get('surface'), as: url.searchParams.get('as'), workspaceId: null,
        result: { resolved: true, provider: 'anthropic', shape: 'api_key', scope: 'team', source: { scope: 'team', secretId: 's', purpose: 'anthropic_api_key', label: null, legacy: true } },
        why: ['team anthropic: used'],
      });
    }
    if (url.pathname === '/api/providers') {
      if (method === 'PATCH') {
        opts = { ...opts, credentialPolicy: body!.credentialPolicy as never };
        return Response.json({ policy: fixturePolicy(opts.credentialPolicy ?? null) });
      }
      if (method === 'PUT') {
        const scope = body!.scope as 'team' | 'workspace' | 'mine';
        opts = { ...opts, rows: [...(opts.rows ?? []), { provider: body!.provider as never, scope, last4: String(body!.value).slice(-4) }] };
        return Response.json({ provider: body!.provider, scope, workspaceId: null, credentials: [] });
      }
      if (method === 'DELETE') {
        const p = url.searchParams.get('provider');
        const s = url.searchParams.get('scope');
        opts = { ...opts, rows: (opts.rows ?? []).filter((r) => !(r.provider === p && r.scope === s)) };
        return Response.json({ provider: p, scope: s, workspaceId: null, credentials: [], deleted: 1 });
      }
      return Response.json(fixtureResponse({ ...opts, workspaceId: url.searchParams.get('workspaceId') }));
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function mount(o: FixtureOpts = {}, withSignIns = false, workspaces = WORKSPACES) {
  opts = o;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<ModelProvidersClient teamId="t" isAdmin={o.admin !== false} workspaces={workspaces} signIns={withSignIns ? { workspaces: workspaces.map((w) => ({ ...w, teamId: 't' })), currentTeamId: 't' } : undefined} />); });
  await flush();
  await flush();
}
const $ = (sel: string, scope: ParentNode = host) => scope.querySelector(sel) as HTMLElement | null;
const cardOf = (id: string) => $(`[data-testid="provider-card-${id}"]`)!;
const buttons = (scope: ParentNode) => [...scope.querySelectorAll('button')].map((b) => b.textContent?.replace('▶', '').trim());
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll('button')].find((b) => b.textContent?.replace('▶', '').trim() === text) as HTMLButtonElement | undefined;
async function click(el: HTMLElement | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => { el!.click(); });
  await flush();
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const toggle = (id: string) => $('[data-testid="provider-row-toggle"]', cardOf(id));

describe('one row per provider, in registry order', () => {
  it('Claude and OpenAI each group their key and subscription; no compatibility text anywhere', async () => {
    await mount();
    const ids = [...host.querySelectorAll('[data-testid^="provider-card-"][data-scope]')].map((e) => e.getAttribute('data-testid')!.replace('provider-card-', ''));
    expect(ids).toEqual(['claude', 'openai', 'openrouter', 'litellm', 'custom-endpoint']);
    const text = host.textContent!;
    expect(text).not.toMatch(/Not (chat|codex|claude|cloud)/i);
    expect(text).not.toContain('What runs?');
    expect(text).not.toMatch(/\bruns\b|wire|seat/i);
  });

  it('a row is name, status word, masked key and one action; detail opens on tap', async () => {
    await mount({ rows: [{ provider: 'anthropic', scope: 'team', last4: 'a1b2' }] });
    const c = cardOf('claude');
    expect(c.getAttribute('data-set')).toBe('true');
    expect($('[data-testid="provider-card-state"]', c)!.textContent).toBe('Working');
    expect($('[data-testid="provider-masked"]', c)!.textContent).toBe('…a1b2');
    expect(buttons(c)).toContain('Replace');
    expect($('[data-testid="provider-detail"]', c)).toBeNull();
    await click(toggle('claude'));
    expect($('[data-testid="provider-row"]', c)!.textContent).toContain('…a1b2');
    expect(buttons(c)).toContain('Remove');
  });

  it('only one row is open at a time', async () => {
    await mount();
    await click(toggle('claude'));
    await click(toggle('openai'));
    expect($('[data-testid="provider-detail"]', cardOf('claude'))).toBeNull();
    expect($('[data-testid="provider-detail"]', cardOf('openai'))).toBeTruthy();
  });
});

describe('connect: one input, the format decides', () => {
  it('a Claude API key goes to Anthropic', async () => {
    await mount();
    await click(button(cardOf('claude'), 'Connect Claude'));
    await type($('input[type="password"]', cardOf('claude')) as HTMLInputElement, PASTED);
    await click(button(cardOf('claude'), 'Save'));
    expect(calls.find((x) => x.method === 'PUT')!.body).toMatchObject({ provider: 'anthropic', shape: 'api_key', scope: 'team' });
    expect(host.innerHTML).not.toContain(PASTED);
  });

  it('a Claude setup token goes to the subscription', async () => {
    await mount();
    await click(button(cardOf('claude'), 'Connect Claude'));
    await type($('input[type="password"]', cardOf('claude')) as HTMLInputElement, 'sk-ant-oat01-illustrative-not-real');
    await click(button(cardOf('claude'), 'Save'));
    expect(calls.find((x) => x.method === 'PUT')!.body).toMatchObject({ provider: 'claude-subscription', shape: 'setup_token' });
  });

  it('something that is neither is refused before anything is sent', async () => {
    await mount();
    await click(button(cardOf('claude'), 'Connect Claude'));
    await type($('input[type="password"]', cardOf('claude')) as HTMLInputElement, 'not-a-key');
    await click(button(cardOf('claude'), 'Save'));
    expect(calls.filter((x) => x.method === 'PUT')).toHaveLength(0);
    expect($('[role="alert"]', cardOf('claude'))!.textContent).toContain('sk-ant-api');
  });

  it('sign-ins are folded into the provider row, not linked to another section', async () => {
    await mount({}, true);
    expect($('[data-testid="provider-connect-seat"]', cardOf('openai'))).toBeNull();
    expect($('#sign-ins')).toBeTruthy();
    // Shut, the Claude and OpenAI sign-ins are hidden; open, they show.
    expect($('[data-testid="provider-sign-in"]', cardOf('openai'))!.hasAttribute('hidden')).toBe(true);
    await click(toggle('openai'));
    const openai = $('[data-testid="provider-sign-in"]', cardOf('openai'))!;
    expect(openai.hasAttribute('hidden')).toBe(false);
    expect($('[data-testid="codex-row"]', openai)).toBeTruthy();
    await click(toggle('claude'));
    expect($('[data-testid="claude-row"]', $('[data-testid="provider-sign-in"]', cardOf('claude'))!)).toBeTruthy();
    // One row per provider: no second row header for the same provider.
    expect(host.querySelectorAll('[data-testid="codex-row"] button[aria-expanded]')).toHaveLength(0);
    expect($('[data-testid="provider-sign-in"]', cardOf('openrouter'))).toBeNull();
  });

  it('the page has no Runner sign-ins section', async () => {
    await mount({}, true);
    expect(host.textContent).not.toContain('Runner sign-ins');
    expect($('[data-testid="models-sign-ins"]')).toBeNull();
  });

  it('gateways set up under Routing', async () => {
    await mount();
    expect($('a[href="#routing"]', cardOf('litellm'))!.textContent).toBe('Set up');
    expect($('#routing')).toBeTruthy();
    expect($('#advanced')).toBeTruthy();
  });

  it('remove asks first, then deletes at the tab scope', async () => {
    await mount({ rows: [{ provider: 'openai', scope: 'team' }] });
    await click(toggle('openai'));
    await click(button(cardOf('openai'), 'Remove'));
    await click(button(cardOf('openai'), 'Confirm remove'));
    const del = calls.find((x) => x.method === 'DELETE')!;
    expect(del.url).toContain('provider=openai');
    expect(del.url).toContain('scope=team');
    expect(cardOf('openai').getAttribute('data-set')).toBe('false');
  });
});

describe('scope tabs', () => {
  it('Workspace shows the team key it uses, and pastes go to that workspace', async () => {
    await mount({ rows: [{ provider: 'anthropic', scope: 'team' }] });
    await click($('[data-testid="scope-tab-workspace"]'));
    const c = cardOf('claude');
    expect($('[data-testid="provider-card-state"]', c)!.textContent).toBe('Team key');
    await click(button(c, 'Connect Claude'));
    expect($('[data-testid="provider-inherits"]', c)!.textContent).toContain('…a1b2');
    await type($('input[type="password"]', c) as HTMLInputElement, PASTED);
    await click(button(c, 'Save'));
    expect(calls.find((x) => x.method === 'PUT')!.body).toMatchObject({ provider: 'anthropic', scope: 'workspace', workspaceId: 'ws-a', shape: 'api_key' });
  });

  it('Mine: team-only providers say so only when opened, with no action', async () => {
    await mount({ credentialPolicy: 'personal_first' });
    await click($('[data-testid="scope-tab-mine"]'));
    expect($('[data-testid="provider-card-state"]', cardOf('litellm'))!.textContent).toBe('Not available');
    expect(buttons(cardOf('litellm')).filter((b) => b !== 'LiteLLM gateway')).toEqual([expect.stringContaining('LiteLLM')]);
    await click(toggle('litellm'));
    expect($('[data-testid="provider-closed"]', cardOf('litellm'))!.textContent).toContain("team's shared configuration");
    expect(button(cardOf('claude'), 'Connect Claude')).toBeDefined();
  });

  it('Mine is read-only under a team-only policy', async () => {
    await mount({ credentialPolicy: 'team' });
    await click($('[data-testid="scope-tab-mine"]'));
    expect(button(cardOf('claude'), 'Connect Claude')).toBeUndefined();
    await click(toggle('claude'));
    expect($('[data-testid="provider-read-only"]', cardOf('claude'))!.textContent).toBe("Your team's policy doesn't use personal keys.");
  });

  it('?scope=mine opens on Mine', async () => {
    search = new URLSearchParams('scope=mine');
    await mount({ credentialPolicy: 'personal_first' });
    expect($('[data-testid="scope-tab-mine"]')!.getAttribute('aria-selected')).toBe('true');
    expect(cardOf('claude').getAttribute('data-scope')).toBe('mine');
  });

  it('with no workspaces the Workspace tab is disabled', async () => {
    await mount({}, false, []);
    expect(($('[data-testid="scope-tab-workspace"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a member sees rows with no actions, and why only when opened', async () => {
    await mount({ admin: false, rows: [{ provider: 'anthropic', scope: 'team' }] });
    const c = cardOf('claude');
    expect(buttons(c).filter((b) => !b?.startsWith('Claude'))).toEqual([]);
    await click(toggle('claude'));
    expect($('[data-testid="provider-read-only"]', c)!.textContent).toBe('Admins can change this.');
  });
});

describe('who pays', () => {
  it('hidden while nobody in the team has a personal key and the policy is the default', async () => {
    await mount({ credentialPolicy: null, personalKeyCount: 0 });
    expect($('[data-testid="credential-policy"]')).toBeNull();
    expect(host.textContent).not.toMatch(/No policy chosen|Pick one/);
  });

  it('shown once someone has a personal key, with Team key chosen by default and no warning', async () => {
    await mount({ credentialPolicy: null, personalKeyCount: 1 });
    const radios = [...host.querySelectorAll('[data-testid="credential-policy"] [role="radio"]')] as HTMLButtonElement[];
    expect(radios.map((r) => r.textContent)).toEqual(['Team key', "Mine, then the team's", 'Mine only']);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    expect($('[data-testid="credential-policy-hint"]')!.textContent).toBe("Everyone uses the team's key.");
  });

  it('an admin switches it: PATCH credentialPolicy', async () => {
    await mount({ credentialPolicy: null, personalKeyCount: 1 });
    const mine = [...host.querySelectorAll('[role="radio"]')].find((r) => r.textContent === "Mine, then the team's") as HTMLButtonElement;
    await click(mine);
    expect(calls.find((x) => x.method === 'PATCH')!.body).toEqual({ teamId: 't', credentialPolicy: 'personal_first' });
  });

  it('a member reads it as one line', async () => {
    await mount({ admin: false, credentialPolicy: 'personal_only' });
    expect(host.querySelector('[role="radio"]')).toBeNull();
    expect($('[data-testid="credential-policy-line"]')!.textContent).toBe('Mine only. You need your own key to start work.');
  });
});

for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  describe(`at ${vp.width}px`, () => {
    beforeEach(() => {
      (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport(vp);
    });
    it('renders every row and the policy without an em dash', async () => {
      await mount({ rows: [{ provider: 'anthropic', scope: 'team' }], personalKeyCount: 1 });
      expect(host.querySelectorAll('[data-testid^="provider-card-"][data-scope]').length).toBe(5);
      expect($('[data-testid="credential-policy"]')!.textContent).not.toContain('—');
      for (const c of host.querySelectorAll('[data-testid^="provider-card-"][data-scope]')) expect(c.textContent).not.toContain('—');
    });
  });
}

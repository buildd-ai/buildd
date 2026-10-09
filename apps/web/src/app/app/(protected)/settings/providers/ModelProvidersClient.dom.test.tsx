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
async function mount(o: FixtureOpts = {}, workspaces = WORKSPACES) {
  opts = o;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<ModelProvidersClient teamId="t" isAdmin={o.admin !== false} workspaces={workspaces} />); });
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

describe('one card per provider, in registry order', () => {
  it('renders every registry provider with what it serves and the reason for what it cannot', async () => {
    await mount();
    const ids = [...host.querySelectorAll('[data-testid^="provider-card-"][data-scope]')].map((e) => e.getAttribute('data-testid')!.replace('provider-card-', ''));
    expect(ids).toEqual(['anthropic', 'claude-subscription', 'openai', 'codex-subscription', 'openrouter', 'litellm', 'custom-endpoint']);
    expect($('[data-testid="provider-serves"]', cardOf('openai'))!.textContent).toContain('Chat · codex runs');
    const not = $('[data-testid="provider-not"]', cardOf('openai'))!.textContent!;
    expect(not).toContain('Claude Code speaks the Anthropic Messages API');
    expect(not).toContain('Not cloud runs');
  });

  it('a stored row shows its last four, health and what it serves today, never the value', async () => {
    await mount({ rows: [{ provider: 'anthropic', scope: 'team', last4: 'a1b2' }] });
    const c = cardOf('anthropic');
    expect(c.getAttribute('data-set')).toBe('true');
    expect($('[data-testid="provider-row"]', c)!.textContent).toContain('…a1b2');
    expect($('[data-testid="provider-card-state"]', c)!.textContent).toContain('healthy');
    expect($('[data-testid="provider-row-serves"]', c)!.textContent).toBe('Used for chat · claude runs · cloud runs');
  });
});

describe('scope tabs', () => {
  it('Workspace shows the team row it inherits, and pastes go to that workspace', async () => {
    await mount({ rows: [{ provider: 'anthropic', scope: 'team' }] });
    await click($('[data-testid="scope-tab-workspace"]'));
    const c = cardOf('anthropic');
    expect($('[data-testid="provider-inherits"]', c)!.textContent).toContain('Inherits team: API key …a1b2');
    await click(button(c, 'Add API key'));
    await type($('input[type="password"]', c) as HTMLInputElement, PASTED);
    await click(button(c, 'Save'));
    const put = calls.find((x) => x.method === 'PUT')!;
    expect(put.body).toMatchObject({ provider: 'anthropic', scope: 'workspace', workspaceId: 'ws-a', shape: 'api_key' });
  });

  it('Mine closes a provider the registry keeps team-only, with its reason', async () => {
    await mount({ credentialPolicy: 'personal_first' });
    await click($('[data-testid="scope-tab-mine"]'));
    expect($('[data-testid="provider-closed"]', cardOf('litellm'))!.textContent).toContain("team's shared configuration");
    expect(buttons(cardOf('litellm'))).not.toContain('Add API key');
    expect(button(cardOf('anthropic'), 'Add API key')).toBeDefined();
  });

  it('Mine is read-only under a team-only policy', async () => {
    await mount({ credentialPolicy: 'team' });
    await click($('[data-testid="scope-tab-mine"]'));
    expect($('[data-testid="provider-read-only"]', cardOf('anthropic'))!.textContent).toBe("Your team's policy doesn't use personal keys.");
  });

  it('?scope=mine opens on Mine', async () => {
    search = new URLSearchParams('scope=mine');
    await mount({ credentialPolicy: 'personal_first' });
    expect($('[data-testid="scope-tab-mine"]')!.getAttribute('aria-selected')).toBe('true');
    expect(cardOf('anthropic').getAttribute('data-scope')).toBe('mine');
  });

  it('with no workspaces the Workspace tab is disabled', async () => {
    await mount({}, []);
    expect(($('[data-testid="scope-tab-workspace"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('set, replace, remove', () => {
  it('a pasted key is sent once and never stays in the DOM', async () => {
    await mount();
    const c = cardOf('anthropic');
    await click(button(c, 'Add API key'));
    await type($('input[type="password"]', c) as HTMLInputElement, PASTED);
    await click(button(c, 'Save'));
    expect(calls.filter((x) => x.method === 'PUT')).toHaveLength(1);
    expect(host.innerHTML).not.toContain(PASTED);
    expect($('[data-testid="provider-row"]', cardOf('anthropic'))!.textContent).toContain('…0000');
  });

  it('remove asks first, then deletes at the tab scope', async () => {
    await mount({ rows: [{ provider: 'openai', scope: 'team' }] });
    await click(button(cardOf('openai'), 'Remove'));
    await click(button(cardOf('openai'), 'Confirm remove'));
    const del = calls.find((x) => x.method === 'DELETE')!;
    expect(del.url).toContain('provider=openai');
    expect(del.url).toContain('scope=team');
    expect(cardOf('openai').getAttribute('data-set')).toBe('false');
  });

  it('a member sees rows read-only with "Admins can change this"', async () => {
    await mount({ admin: false, rows: [{ provider: 'anthropic', scope: 'team' }] });
    const c = cardOf('anthropic');
    expect($('[data-testid="provider-read-only"]', c)!.textContent).toBe('Admins can change this.');
    expect(buttons(c).filter((b) => b !== 'What runs?')).toEqual([]);
  });

  it('subscription seats link to the browser flow; gateways link to their form under Advanced', async () => {
    await mount();
    expect($('[data-testid="provider-connect-seat"]', cardOf('codex-subscription'))!.getAttribute('href')).toBe('/app/settings/runners#agent-backends');
    expect(button(cardOf('claude-subscription'), 'Add setup token')).toBeDefined();
    expect($('a[href="#advanced"]', cardOf('litellm'))).toBeTruthy();
    expect($('#advanced')).toBeTruthy();
  });
});

describe('credential policy', () => {
  it('unset: says agents use team keys and that picking one opts agent runs in', async () => {
    await mount({ credentialPolicy: null });
    const unset = $('[data-testid="credential-policy-unset"]')!.textContent!;
    expect(unset).toContain('Not chosen yet: agents use team keys.');
    expect(unset).toContain('apply it to agent runs');
    const radios = [...host.querySelectorAll('input[name="credential-policy"]')] as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['team', 'personal_first', 'personal_only']);
    expect(radios.some((r) => r.checked)).toBe(false);
  });

  it('an admin picks one: PATCH credentialPolicy, and the unset line goes away', async () => {
    await mount({ credentialPolicy: null });
    await click(host.querySelector('input[value="personal_first"]') as HTMLInputElement);
    expect(calls.find((x) => x.method === 'PATCH')!.body).toEqual({ teamId: 't', credentialPolicy: 'personal_first' });
    expect($('[data-testid="credential-policy-unset"]')).toBeNull();
    expect((host.querySelector('input[value="personal_first"]') as HTMLInputElement).checked).toBe(true);
  });

  it('a member reads the policy as one sentence, no radios', async () => {
    await mount({ admin: false, credentialPolicy: 'personal_only' });
    expect(host.querySelector('input[name="credential-policy"]')).toBeNull();
    expect($('[data-testid="credential-policy-line"]')!.textContent).toBe('Agent runs and chat: your key only (no team key).');
  });
});

describe('What runs?', () => {
  it('asks the explain endpoint per surface the provider serves, as team work on Team', async () => {
    await mount({ rows: [{ provider: 'anthropic', scope: 'team' }] });
    await click(button(cardOf('anthropic'), 'What runs?'));
    await flush();
    const asked = calls.filter((x) => x.url.startsWith('/api/providers/explain')).map((x) => new URL(x.url, 'http://l').searchParams);
    expect(asked.map((p) => p.get('surface'))).toEqual(['chat', 'agent-claude', 'cloud-egress']);
    expect(asked.every((p) => p.get('as') === 'team' && p.get('provider') === 'anthropic')).toBe(true);
    const lines = [...cardOf('anthropic').querySelectorAll('[data-testid="provider-explain-line"]')].map((e) => e.textContent);
    expect(lines).toContain('Claude runs use Anthropic: API key, team key.');
  });

  it('on Mine it explains your own work', async () => {
    await mount({ credentialPolicy: 'personal_first' });
    await click($('[data-testid="scope-tab-mine"]'));
    await click(button(cardOf('openai'), 'What runs?'));
    await flush();
    const asked = calls.filter((x) => x.url.startsWith('/api/providers/explain')).map((x) => new URL(x.url, 'http://l').searchParams);
    expect(asked.every((p) => p.get('as') === 'self')).toBe(true);
  });
});

for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  describe(`at ${vp.width}px`, () => {
    beforeEach(() => {
      (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport(vp);
    });
    it('renders every card and the policy without an em dash', async () => {
      await mount({ rows: [{ provider: 'anthropic', scope: 'team' }] });
      expect(host.querySelectorAll('[data-testid^="provider-card-"][data-scope]').length).toBe(7);
      expect($('[data-testid="credential-policy"]')!.textContent).not.toContain('—');
      for (const c of host.querySelectorAll('[data-testid^="provider-card-"][data-scope]')) expect(c.textContent).not.toContain('—');
    });
  });
}

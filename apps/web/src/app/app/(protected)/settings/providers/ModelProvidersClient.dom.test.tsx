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
let assigned: Record<string, unknown> = {};
let withKeys: string[] = [];
const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];

beforeEach(() => {
  search = new URLSearchParams();
  opts = {};
  calls.length = 0;
  assigned = {};
  withKeys = [];
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
    if (url.pathname === '/api/providers/assignments') {
      if (method === 'PATCH') assigned = { ...assigned, [String(body!.surface)]: body!.provider };
      return Response.json({ assignments: assigned });
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
      return Response.json({ ...fixtureResponse({ ...opts, workspaceId: url.searchParams.get('workspaceId') }), workspacesWithKeys: withKeys });
    }
    if (url.pathname === '/api/teams/t/litellm-gateway') {
      const set = (opts.rows ?? []).some((r) => r.provider === 'litellm' && r.scope === 'team');
      return Response.json({ gateway: set ? { baseURL: 'https://litellm.example.com/v1', last4: 'abcd', health: 'healthy', lastVerificationError: null } : null });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function mount(o: FixtureOpts = {}, withSignIns = false, workspaces = WORKSPACES, scope: 'team' | 'workspace' | 'mine' = 'team') {
  opts = o;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<ModelProvidersClient teamId="t" isAdmin={o.admin !== false} workspaces={workspaces} signIns={withSignIns ? { workspaces: workspaces.map((w) => ({ ...w, teamId: 't' })), currentTeamId: 't' } : undefined} scope={scope} workspaceId={scope === 'workspace' ? workspaces[0]?.id ?? null : null} />); });
  await flush();
  await flush();
}
const $ = (sel: string, scope: ParentNode = host) => scope.querySelector(sel) as HTMLElement | null;
const cardOf = (id: string, list = 'team') => $(`[data-testid="provider-list-${list}"] [data-testid="provider-card-${id}"]`) ?? $(`[data-testid="provider-card-${id}"]`)!;
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

const toggle = (id: string, list = 'team') => $('[data-testid="provider-row-toggle"]', cardOf(id, list));

describe('one row per provider, in registry order', () => {
  it('Claude and OpenAI each group their key and subscription; no compatibility text anywhere', async () => {
    await mount();
    const ids = [...host.querySelectorAll('[data-testid="provider-list-team"] [data-testid^="provider-card-"][data-scope]')].map((e) => e.getAttribute('data-testid')!.replace('provider-card-', ''));
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

  it('the gateway and the custom endpoint set up in their own rows; old Routing links still land', async () => {
    await mount();
    // One row open at a time: each form shows inside its own opened row.
    for (const [id, form] of [['litellm', 'litellm-gateway'], ['custom-endpoint', 'agent-endpoint']]) {
      await click(button(cardOf(id), 'Set up'));
      expect($(`[data-testid="provider-detail"] [data-testid="${form}"]`, cardOf(id))).toBeTruthy();
    }
    expect(host.textContent).not.toContain('Edit under Routing');
    expect($('#routing')).toBeTruthy();
    expect($('#advanced')).toBeTruthy();
  });

  it('an opened gateway row says its key and offers Remove once: the form owns both', async () => {
    await mount({ rows: [{ provider: 'litellm', scope: 'team', shape: 'gateway', last4: 'abcd' }] });
    await click($('[data-testid="provider-row-toggle"]', cardOf('litellm')));
    await flush();
    const detail = $('[data-testid="provider-detail"]', cardOf('litellm'))!;
    expect([...detail.querySelectorAll('button')].filter((b) => b.textContent === 'Remove')).toHaveLength(1);
    expect(detail.textContent!.split('abcd')).toHaveLength(2);
  });

  it('a workspace page leaves out a row it cannot set there, unless the team has one', async () => {
    await mount({ rows: [{ provider: 'anthropic', scope: 'workspace' }] }, false, WORKSPACES, 'workspace');
    expect($('[data-testid="provider-list-workspace"] [data-testid="provider-card-litellm"]')).toBeNull();
    act(() => root.unmount()); host.remove();
    await mount({ rows: [{ provider: 'anthropic', scope: 'workspace' }, { provider: 'litellm', scope: 'team', shape: 'gateway' }] }, false, WORKSPACES, 'workspace');
    expect($('[data-testid="provider-card-state"]', cardOf('litellm', 'workspace'))!.textContent).toBe('Team key');
  });

  it('one provider: no Used for table, one line saying what it is used for', async () => {
    await mount({ rows: [{ provider: 'openrouter', scope: 'team' }] });
    expect($('[data-testid="used-for"]')).toBeNull();
    expect($('[data-testid="provider-lone"]')!.textContent).toMatch(/^OpenRouter is used for chat/);
  });

  it('two providers: a picker per surface, and a pick is saved for that surface only', async () => {
    await mount({ rows: [{ provider: 'openrouter', scope: 'team' }, { provider: 'anthropic', scope: 'team' }] });
    expect($('[data-testid="used-for"]')).toBeTruthy();
    for (const s of ['chat', 'agent-claude', 'agent-codex', 'cloud-egress']) expect($(`[data-testid="used-for-${s}"]`)).toBeTruthy();
    expect($('[data-testid="used-for-decisions"]')).toBeTruthy();
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

describe('one scope per page', () => {
  it('Models holds only the team keys: no workspace picker, no Workspace keys section', async () => {
    await mount({ rows: [{ provider: 'anthropic', scope: 'team' }] });
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    const team = [...host.querySelectorAll('[data-testid="provider-list-team"] [data-scope]')].map((e) => e.getAttribute('data-scope'));
    expect(new Set(team)).toEqual(new Set(['team']));
    expect(host.querySelector('[data-testid="provider-list-workspace"]')).toBeNull();
    expect($('[data-testid="scope-workspace"]')).toBeNull();
    expect(host.textContent).not.toContain('Workspace keys');
    expect($('[data-testid="workspaces-with-keys"]')).toBeNull();
  });

  it('names the workspaces that use their own keys, each linked to its settings', async () => {
    withKeys = [WORKSPACES[0].id];
    await mount({ rows: [{ provider: 'anthropic', scope: 'team' }] });
    const line = $('[data-testid="workspaces-with-keys"]')!;
    expect(line.textContent).toBe(`1 workspace uses its own keys: ${WORKSPACES[0].name}`);
    expect($('a', line)!.getAttribute('href')).toBe(`/app/settings/workspace/${WORKSPACES[0].id}#models`);
  });

  it('a workspace page: uses team settings until an admin overrides, then pastes go to that workspace', async () => {
    await mount({ rows: [{ provider: 'anthropic', scope: 'team' }] }, false, WORKSPACES, 'workspace');
    expect($('[data-testid="workspace-uses-team"]')!.textContent).toContain('Uses team settings.');
    expect(host.querySelector('[data-testid="provider-list-workspace"]')).toBeNull();
    expect(host.querySelector('[data-testid="provider-list-team"]')).toBeNull();
    await click(button(host, 'Override')!);
    const c = cardOf('claude', 'workspace');
    expect($('[data-testid="provider-card-state"]', c)!.textContent).toBe('Team key');
    await click(button(c, 'Connect Claude'));
    await type($('input[type="password"]', c) as HTMLInputElement, PASTED);
    await click(button(c, 'Save'));
    expect(calls.find((x) => x.method === 'PUT')!.body).toMatchObject({ provider: 'anthropic', scope: 'workspace', workspaceId: WORKSPACES[0].id, shape: 'api_key' });
  });

  it('a workspace page with its own key lists it straight away', async () => {
    await mount({ rows: [{ provider: 'anthropic', scope: 'workspace' }] }, false, WORKSPACES, 'workspace');
    expect($('[data-testid="workspace-uses-team"]')).toBeNull();
    expect(host.querySelector('[data-testid="provider-list-workspace"]')).toBeTruthy();
  });

  it('Keys holds only your keys: no team rows, no routing, the policy as a line', async () => {
    await mount({ credentialPolicy: 'personal_first' }, false, WORKSPACES, 'mine');
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(new Set([...host.querySelectorAll('[data-scope]')].map((e) => e.getAttribute('data-scope')))).toEqual(new Set(['mine']));
    expect(host.textContent).not.toContain('Routing');
    expect(host.textContent).not.toContain('Workspace keys');
    expect(host.querySelector('[role="radio"]')).toBeNull();
    expect($('[data-testid="credential-policy-line"]')!.textContent).toBe("Your key goes first. The team's key is the fallback.");
    // The list is asked for without a workspace: nothing here is one.
    expect(calls.find((x) => x.url.startsWith('/api/providers?'))!.url).not.toContain('workspaceId');
  });

  it('Keys: team-only providers say so only when opened, with no action', async () => {
    await mount({ credentialPolicy: 'personal_first' }, false, WORKSPACES, 'mine');
    expect($('[data-testid="provider-card-state"]', cardOf('litellm', 'mine'))!.textContent).toBe('Not available');
    expect(buttons(cardOf('litellm', 'mine')).filter((b) => b !== 'LiteLLM gateway')).toEqual([expect.stringContaining('LiteLLM')]);
    await click(toggle('litellm', 'mine'));
    expect($('[data-testid="provider-closed"]', cardOf('litellm', 'mine'))!.textContent).toContain("team's shared configuration");
    expect(button(cardOf('claude', 'mine'), 'Connect Claude')).toBeDefined();
  });

  it('Keys is read-only under a team-only policy, and says why', async () => {
    await mount({ credentialPolicy: 'team' }, false, WORKSPACES, 'mine');
    expect(button(cardOf('claude', 'mine'), 'Connect Claude')).toBeUndefined();
    await click(toggle('claude', 'mine'));
    expect($('[data-testid="provider-read-only"]', cardOf('claude', 'mine'))!.textContent).toBe("Your team's policy doesn't use personal keys.");
  });

  it('a member sees team rows with no actions and no per-row admin line (the page says it once)', async () => {
    await mount({ admin: false, rows: [{ provider: 'anthropic', scope: 'team' }] });
    for (const list of ['team', 'workspace']) {
      const c = cardOf('claude', list);
      expect(buttons(c).filter((b) => !b?.startsWith('Claude'))).toEqual([]);
      await click(toggle('claude', list));
      expect($('[data-testid="provider-read-only"]', c)).toBeNull();
    }
    expect(host.textContent).not.toContain('Admins can change');
  });
});

describe('whose key', () => {
  for (const credentialPolicy of [null, 'personal_first'] as const) {
    it(`no setting and no line on Models for the default (${credentialPolicy ?? 'unset'}), whoever has a personal key`, async () => {
      await mount({ credentialPolicy, personalKeyCount: 3 });
      expect($('[data-testid="credential-policy"]')).toBeNull();
      expect(host.querySelector('[role="radio"]')).toBeNull();
      expect(host.textContent).not.toMatch(/who pays/i);
    });
  }

  it('a stored exception is one line, and an admin goes back to the default: PATCH credentialPolicy null', async () => {
    await mount({ credentialPolicy: 'team' });
    expect($('[data-testid="credential-policy-line"]')!.textContent).toBe('This team uses team keys only.');
    await click($('[data-testid="credential-policy-reset"]') as HTMLButtonElement);
    expect(calls.find((x) => x.method === 'PATCH')!.body).toEqual({ teamId: 't', credentialPolicy: null });
    expect($('[data-testid="credential-policy"]')).toBeNull();
  });

  it('a member reads the exception, with no way to change it', async () => {
    await mount({ admin: false, credentialPolicy: 'personal_only' });
    expect($('[data-testid="credential-policy-line"]')!.textContent).toBe('This team uses personal keys only.');
    expect($('[data-testid="credential-policy-reset"]')).toBeNull();
  });
});

for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  describe(`at ${vp.width}px`, () => {
    beforeEach(() => {
      (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport(vp);
    });
    it('renders every row and the policy without an em dash', async () => {
      await mount({ rows: [{ provider: 'anthropic', scope: 'team' }], credentialPolicy: 'team' });
      expect(host.querySelectorAll('[data-testid="provider-list-team"] [data-testid^="provider-card-"][data-scope]').length).toBe(5);
      expect($('[data-testid="credential-policy"]')!.textContent).not.toContain('—');
      for (const c of host.querySelectorAll('[data-testid^="provider-card-"][data-scope]')) expect(c.textContent).not.toContain('—');
    });
  });
}

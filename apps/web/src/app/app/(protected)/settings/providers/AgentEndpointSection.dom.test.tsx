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
const previews: unknown[] = [];
const suggests: unknown[] = [];
let modelsReply: unknown = { available: false, listed: [], rows: [] };
let suggestReply: { status: number; body: unknown } = { status: 200, body: { suggestions: [] } };

const teamEndpoint = {
  id: 's-1', scope: 'team', workspaceId: null, workspaceName: null, kind: 'anthropic-compatible',
  baseUrl: 'https://litellm.example.com', authHeader: 'authorization', models: { 'claude-haiku-4-5-20251001': 'claude-haiku-4-5' }, last4: '1234',
  gatewayMissing: false, health: 'healthy', lastVerifiedAt: '2026-01-02T03:04:05.000Z', lastVerificationError: null,
  mapping: [
    { model: 'claude-sonnet-5', tiers: ['standard'], sent: 'claude-sonnet-5' },
    { model: 'claude-haiku-4-5-20251001', tiers: ['budget'], sent: 'claude-haiku-4-5' },
  ],
};

beforeEach(() => {
  writes.length = 0;
  previews.length = 0;
  suggests.length = 0;
  endpoints = [];
  gateway = null;
  modelsReply = { available: false, listed: [], rows: [] };
  suggestReply = { status: 200, body: { suggestions: [] } };
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith('/agent-endpoint/models')) { previews.push(body); return new Response(JSON.stringify(modelsReply), { status: 200 }); }
    if (url.endsWith('/agent-endpoint/models/suggest')) { suggests.push(body); return new Response(JSON.stringify(suggestReply.body), { status: suggestReply.status }); }
    if (method !== 'GET') { writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null }); return new Response('{}', { status: 200 }); }
    if (url.endsWith('/litellm-gateway')) return new Response(JSON.stringify({ gateway }), { status: 200 });
    return new Response(JSON.stringify({ endpoints }), { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(canManage = true, workspaces = [{ id: 'ws-1', name: 'Widgets' }]) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<AgentEndpointSection teamId="t" canManage={canManage} workspaces={workspaces} />); });
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
/** Past the editor's debounce before it asks for the endpoint's models. */
const settle = async (ms = 400) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="endpoint-model-row"]')];
const row = (model: string) => rows().find((r) => r.dataset.model === model)!;
const pickOption = async (trigger: Element, label: string) => {
  await act(async () => { (trigger as HTMLElement).click(); });
  const o = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((x) => x.textContent?.startsWith(label));
  await act(async () => { o!.click(); });
};
const LISTED = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-4o-mini'];
const ROWS = [
  { model: 'claude-opus-5', tiers: ['premium'], value: null, source: 'listed', served: true },
  { model: 'claude-haiku-4-5-20251001', tiers: ['budget'], value: 'claude-haiku-4-5', source: 'equivalent', served: true },
  { model: 'claude-fable-5-1', tiers: ['premium-plus'], value: null, source: null, served: false },
];
async function openCustom() {
  await mount();
  await click(button('Set up an endpoint'));
  await click(kindRadio(3));
  await setValue(host.querySelector('#agent-endpoint-url') as HTMLInputElement, 'https://litellm.example.com');
  await setValue(host.querySelector('#agent-endpoint-key') as HTMLInputElement, KEY);
  await settle();
}

describe('AgentEndpointSection', () => {
  it('nothing set: Anthropic is the default and nothing says metered', async () => {
    await mount();
    expect(text('agent-endpoint-status')).toBe('Anthropic (default)');
    expect(host.querySelector('[data-testid="agent-endpoint-metered"]')).toBeNull();
  });

  it('saved view: the heading names the route and its scope, a status chip, the mapping read-only, metering as plain text', async () => {
    endpoints = [teamEndpoint];
    await mount();
    expect(text('agent-endpoint-heading')).toBe('Anthropic-compatible URL · All workspaces');
    expect(text('agent-endpoint-detail')).toBe('https://litellm.example.com · key …1234');
    expect(host.querySelector('[data-testid="agent-endpoint-health"]')?.textContent).toMatch(/working/i);
    expect(text('agent-endpoint-metered')).toMatch(/metered/);
    expect(text('agent-endpoint-metered')).toMatch(/not a Claude seat/);
    expect(host.querySelector('[data-testid="agent-endpoint-metered"]')!.className).not.toMatch(/notice/);
    const mapped = [...host.querySelectorAll<HTMLElement>('[data-testid="endpoint-mapping-row"]')];
    expect(mapped.map((r) => r.dataset.model)).toEqual(['claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    expect(mapped[0].textContent).toMatch(/as is/);
    expect(mapped[1].textContent).toContain('claude-haiku-4-5');
    expect(mapped[1].textContent).toMatch(/budget/);
    // One action group: Edit, Verify, Remove.
    const actions = host.querySelector('[data-testid="agent-endpoint-actions"]')!;
    expect([...actions.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Edit', 'Verify', 'Remove']);
    expect(host.textContent).not.toContain(KEY);
    expect(host.textContent).not.toContain('Anthropic (default)');
  });

  it('a workspace-only endpoint: its heading names the workspace and says it overrides the team; the rest stay on Anthropic', async () => {
    endpoints = [{ ...teamEndpoint, id: 's-2', scope: 'workspace', workspaceId: 'ws-1', workspaceName: 'Widgets', health: 'unknown', lastVerificationError: 'endpoint returned 502' }];
    await mount();
    expect(text('agent-endpoint-heading')).toBe('Anthropic-compatible URL · Widgets');
    expect(host.querySelector('[data-testid="agent-endpoint-route"]')!.textContent).toMatch(/overrides/i);
    expect(text('agent-endpoint-health')).toMatch(/not confirmed/i);
    expect(host.querySelector('[data-testid="agent-endpoint-route"]')!.textContent).toContain('endpoint returned 502');
    expect(text('agent-endpoint-default')).toMatch(/Anthropic \(default\)/);
  });

  it('Edit opens the editor on that scope', async () => {
    endpoints = [{ ...teamEndpoint, id: 's-2', scope: 'workspace', workspaceId: 'ws-1', workspaceName: 'Widgets' }];
    await mount();
    await click(button('Edit'));
    expect(host.querySelector('[data-testid="agent-endpoint-editor"]')).not.toBeNull();
    expect(host.querySelector('#agent-endpoint-scope')!.textContent).toContain('Widgets');
    expect(host.querySelector('[data-testid="agent-endpoint-actions"]')).toBeNull();
    await click(button('Cancel'));
    expect(host.querySelector('[data-testid="agent-endpoint-editor"]')).toBeNull();
  });

  it('sets a custom URL with a PUT, then clears the key input', async () => {
    await mount();
    await click(button('Set up an endpoint'));
    await click(kindRadio(3));
    await setValue(host.querySelector('#agent-endpoint-url') as HTMLInputElement, 'https://litellm.example.com');
    await setValue(host.querySelector('#agent-endpoint-key') as HTMLInputElement, KEY);
    await click(host.querySelectorAll('input[name="agent-endpoint-header"]')[1]);
    await settle();
    // No model list from this endpoint: typed aliases, behind a disclosure.
    expect(host.querySelector('#agent-endpoint-aliases')).toBeNull();
    await click(button('Enter model names manually'));
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
    await click(button('Set up an endpoint'));
    expect((kindRadio(1) as HTMLInputElement).disabled).toBe(true);
    act(() => root.unmount()); host.remove();
    gateway = { baseURL: 'https://litellm.example.com/v1', last4: 'abcd' };
    await mount();
    await click(button('Set up an endpoint'));
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
    await click(verifies[1]);
    expect(writes.at(-1)).toMatchObject({ url: '/api/secrets/s-2/verify', method: 'POST' });
    const removes = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Remove');
    await click(removes[1]);
    expect(writes.at(-1)).toMatchObject({ url: '/api/teams/t/agent-endpoint?workspaceId=ws-1', method: 'DELETE' });
    await click(removes[0]);
    expect(writes.at(-1)).toMatchObject({ url: '/api/teams/t/agent-endpoint', method: 'DELETE' });
  });

  it('lists the endpoint\'s models: one row per buildd model, prefilled, with the unserved one flagged; saves the mapping', async () => {
    modelsReply = { available: true, listed: LISTED, rows: ROWS };
    await openCustom();
    expect(previews.at(-1)).toEqual({ kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: KEY, authHeader: 'authorization' });
    expect(rows().map((r) => r.dataset.model)).toEqual(ROWS.map((r) => r.model));
    expect(row('claude-haiku-4-5-20251001').textContent).toContain('claude-haiku-4-5');
    expect(row('claude-haiku-4-5-20251001').textContent).toMatch(/budget/);
    expect(row('claude-haiku-4-5-20251001').querySelector('[data-testid="endpoint-model-unserved"]')).toBeNull();
    expect(row('claude-fable-5-1').querySelector('[data-testid="endpoint-model-unserved"]')).not.toBeNull();
    expect(host.querySelector('#agent-endpoint-aliases')).toBeNull();

    // A person may point a row at any listed model, another family included.
    await pickOption(row('claude-fable-5-1').querySelector('button')!, 'gpt-4o-mini');
    expect(row('claude-fable-5-1').querySelector('[data-testid="endpoint-model-unserved"]')).toBeNull();
    await click(button('Save'));
    const put = writes.find((w) => w.method === 'PUT')!;
    expect(put.body).toEqual({
      kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: KEY, authHeader: 'authorization',
      models: { 'claude-haiku-4-5-20251001': 'claude-haiku-4-5', 'claude-fable-5-1': 'gpt-4o-mini' },
    });
  });

  it('asks the decision model only about unmatched rows, shows its pick flagged with the confidence, and never saves on its own', async () => {
    modelsReply = { available: true, listed: LISTED, rows: ROWS };
    suggestReply = { status: 200, body: { suggestions: [{ model: 'claude-fable-5-1', suggested: 'claude-opus-5', confidence: 0.82 }] } };
    await openCustom();
    await settle(50);
    expect(suggests).toEqual([{ listed: LISTED, models: ['claude-fable-5-1'] }]);
    const chip = row('claude-fable-5-1').querySelector('[data-testid="endpoint-model-suggested"]');
    expect(chip?.textContent).toMatch(/suggested/i);
    expect(chip?.textContent).toContain('82%');
    expect(row('claude-fable-5-1').textContent).toContain('claude-opus-5');
    expect(writes).toHaveLength(0);
    await click(button('Save'));
    expect((writes.find((w) => w.method === 'PUT')!.body as { models: Record<string, string> }).models['claude-fable-5-1']).toBe('claude-opus-5');
  });

  it('a failed suggestion call leaves the rows as they were, with no error', async () => {
    modelsReply = { available: true, listed: LISTED, rows: ROWS };
    suggestReply = { status: 500, body: { error: 'nope' } };
    await openCustom();
    await settle(50);
    expect(row('claude-fable-5-1').querySelector('[data-testid="endpoint-model-unserved"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('an existing endpoint loads its saved aliases into the rows without re-entering the key', async () => {
    endpoints = [{ ...teamEndpoint, models: { 'claude-opus-5': 'claude-sonnet-5' } }];
    modelsReply = { available: true, listed: LISTED, rows: [{ model: 'claude-opus-5', tiers: ['premium'], value: 'claude-sonnet-5', source: 'alias', served: true }] };
    await mount();
    await click(button('Edit'));
    await settle();
    expect(previews.at(-1)).toEqual({ kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', authHeader: 'authorization' });
    expect(row('claude-opus-5').textContent).toContain('claude-sonnet-5');
  });

  it('editing an existing endpoint keeps the saved key when the key field is left blank', async () => {
    endpoints = [teamEndpoint];
    await mount();
    await click(button('Edit'));
    const key = host.querySelector('#agent-endpoint-key') as HTMLInputElement;
    expect(key.placeholder).toBe('Saved key …1234, leave blank to keep');
    expect(key.value).toBe('');
    await settle();
    await click(button('Save'));
    const put = writes.find((w) => w.method === 'PUT')!;
    expect(put.body).toEqual({ kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', authHeader: 'authorization', models: { 'claude-haiku-4-5-20251001': 'claude-haiku-4-5' } });
  });

  it('a new endpoint, or a different kind, still needs a key', async () => {
    endpoints = [teamEndpoint];
    await mount();
    await click(button('Edit'));
    await click(kindRadio(2));
    expect((host.querySelector('#agent-endpoint-key') as HTMLInputElement).placeholder).toBe('sk-…');
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is read-only for a member', async () => {
    endpoints = [teamEndpoint];
    await mount(false);
    expect(button('Edit')).toBeUndefined();
    expect(button('Set up an endpoint')).toBeUndefined();
    expect(button('Verify')).toBeUndefined();
    expect(button('Remove')).toBeUndefined();
  });
});

describe('Applies to: which workspaces the team endpoint covers', () => {
  const WORKSPACES = [{ id: 'ws-1', name: 'Widgets' }, { id: 'ws-2', name: 'Gadgets' }, { id: 'ws-3', name: 'Sprockets' }];
  const checkbox = (id: string) => host.querySelector<HTMLInputElement>(`[data-testid="agent-endpoint-applies-workspace"][data-workspace="${id}"]`)!;
  const editor = () => host.querySelector('[data-testid="agent-endpoint-applies-editor"]');
  const appliesRadio = (i: number) => host.querySelectorAll('input[name="agent-endpoint-applies"]')[i];
  const editorButton = (label: string) => [...(editor()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);

  it('shows the current scope: all workspaces, or the count and names', async () => {
    endpoints = [{ ...teamEndpoint, appliesTo: null }];
    await mount(true, WORKSPACES);
    expect(text('agent-endpoint-applies-to')).toBe('Applies to: All workspaces');
    act(() => root.unmount()); host.remove();

    endpoints = [{ ...teamEndpoint, appliesTo: [{ id: 'ws-1', name: 'Widgets' }, { id: 'ws-2', name: 'Gadgets' }] }];
    await mount(true, WORKSPACES);
    expect(text('agent-endpoint-applies-to')).toBe('Applies to: 2 workspaces: Widgets, Gadgets');
    expect(text('agent-endpoint-heading')).toBe('Anthropic-compatible URL · 2 workspaces');
    expect(text('agent-endpoint-default')).toMatch(/Anthropic \(default\)/);
  });

  it('editing the list sends only the list, never a key, and needs no key typed', async () => {
    endpoints = [{ ...teamEndpoint, appliesTo: null }];
    await mount(true, WORKSPACES);
    await click(host.querySelector('[data-testid="agent-endpoint-applies-edit"]'));
    expect(editor()).not.toBeNull();
    // Uses the shared controls: radios and checkboxes, no native select.
    expect(editor()!.querySelector('select')).toBeNull();
    expect(editor()!.querySelector('input[type="password"]')).toBeNull();
    await click(appliesRadio(1));
    expect(editorButton('Save')!.hasAttribute('disabled')).toBe(true);
    await click(checkbox('ws-1'));
    await click(checkbox('ws-3'));
    await click(editorButton('Save'));
    expect(writes).toEqual([{ url: '/api/teams/t/agent-endpoint', method: 'PATCH', body: { appliesTo: ['ws-1', 'ws-3'], consolidate: false } }]);
    expect(JSON.stringify(writes)).not.toContain(KEY);
  });

  it('back to all workspaces sends null', async () => {
    endpoints = [{ ...teamEndpoint, appliesTo: [{ id: 'ws-2', name: 'Gadgets' }] }];
    await mount(true, WORKSPACES);
    await click(host.querySelector('[data-testid="agent-endpoint-applies-edit"]'));
    expect(checkbox('ws-2').checked).toBe(true);
    await click(appliesRadio(0));
    await click(editorButton('Save'));
    expect(writes[0]).toMatchObject({ method: 'PATCH', body: { appliesTo: null, consolidate: false } });
  });

  it('offers to remove a selected workspace\'s matching copy, and says a different one is kept', async () => {
    endpoints = [
      { ...teamEndpoint, appliesTo: null },
      { ...teamEndpoint, id: 'c-1', scope: 'workspace', workspaceId: 'ws-1', workspaceName: 'Widgets', matchesTeam: true },
      { ...teamEndpoint, id: 'c-2', scope: 'workspace', workspaceId: 'ws-2', workspaceName: 'Gadgets', matchesTeam: false },
    ];
    await mount(true, WORKSPACES);
    await click(host.querySelector('[data-testid="agent-endpoint-applies-edit"]'));
    await click(appliesRadio(1));
    expect(host.querySelector('[data-testid="agent-endpoint-consolidate"]')).toBeNull();
    await click(checkbox('ws-1'));
    await click(checkbox('ws-2'));
    expect(editor()!.textContent).toMatch(/own copy of this endpoint/);
    expect(editor()!.textContent).toMatch(/Keeps its own endpoint/);
    const consolidate = host.querySelector<HTMLInputElement>('[data-testid="agent-endpoint-consolidate"]')!;
    expect(consolidate.checked).toBe(true);
    expect(consolidate.parentElement!.textContent).toMatch(/matching copy/);
    await click(editorButton('Save'));
    expect(writes[0].body).toEqual({ appliesTo: ['ws-1', 'ws-2'], consolidate: true });
  });

  it('the owner can keep the copies', async () => {
    endpoints = [
      { ...teamEndpoint, appliesTo: null },
      { ...teamEndpoint, id: 'c-1', scope: 'workspace', workspaceId: 'ws-1', workspaceName: 'Widgets', matchesTeam: true },
    ];
    await mount(true, WORKSPACES);
    await click(host.querySelector('[data-testid="agent-endpoint-applies-edit"]'));
    await click(host.querySelector('[data-testid="agent-endpoint-consolidate"]'));
    await click(editorButton('Save'));
    expect(writes[0].body).toEqual({ appliesTo: null, consolidate: false });
  });

  it('a member sees the scope but cannot edit it', async () => {
    endpoints = [{ ...teamEndpoint, appliesTo: [{ id: 'ws-1', name: 'Widgets' }] }];
    await mount(false, WORKSPACES);
    expect(text('agent-endpoint-applies-to')).toBe('Applies to: 1 workspace: Widgets');
    expect(host.querySelector('[data-testid="agent-endpoint-applies-edit"]')).toBeNull();
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

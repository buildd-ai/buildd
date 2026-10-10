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
const { default: AgentEndpointSection, parseAliasLines, aliasLines, teamOpenRouterKeyLast4 } = await import('./AgentEndpointSection');
const { describeControls } = await import('../_lib/form-controls');

const KEY = 'sk-agent-example-1234';
let endpoints: unknown[] = [];
let gateway: unknown = null;
/** `GET /api/inference-keys` reply; null = the default (no keys). */
let inferenceKeys: unknown = null;
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
  inferenceKeys = null;
  modelsReply = { available: false, listed: [], rows: [] };
  suggestReply = { status: 200, body: { suggestions: [] } };
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith('/agent-endpoint/models')) { previews.push(body); return new Response(JSON.stringify(modelsReply), { status: 200 }); }
    if (url.endsWith('/agent-endpoint/models/suggest')) { suggests.push(body); return new Response(JSON.stringify(suggestReply.body), { status: suggestReply.status }); }
    if (method !== 'GET') { writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null }); return new Response('{}', { status: 200 }); }
    if (url.endsWith('/litellm-gateway')) return new Response(JSON.stringify({ gateway }), { status: 200 });
    if (url.startsWith('/api/inference-keys')) return new Response(JSON.stringify(inferenceKeys ?? { providers: [] }), { status: 200 });
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

  it('saved view: the heading names the route, a status chip, the mapping as one line with the table behind it, metering as plain text', async () => {
    endpoints = [teamEndpoint];
    await mount();
    expect(text('agent-endpoint-heading')).toBe('Anthropic-compatible URL');
    expect(text('agent-endpoint-applies-to')).toBe('Applies to: All workspaces');
    expect(text('agent-endpoint-detail')).toBe('https://litellm.example.com · key …1234');
    expect(host.querySelector('[data-testid="agent-endpoint-health"]')?.textContent).toMatch(/working/i);
    // The last check reads relative, like the provider key cards.
    expect(text('agent-endpoint-checked')).toMatch(/^checked \d+(m|h|d) ago$/);
    expect(text('agent-endpoint-mapping-summary')).toBe('1 model sent as is, 1 → claude-haiku-4-5');
    expect(host.querySelector('[data-testid="endpoint-mapping-row"]')).toBeNull();
    await click(host.querySelector('[data-testid="agent-endpoint-mapping-summary"]')!.closest('button'));
    expect(text('agent-endpoint-metered')).toBe("Billed to the endpoint's key. The per-task dollar cap applies.");
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

  it('a workspace-only endpoint: a compact row named for the workspace; the rest stay on Anthropic', async () => {
    endpoints = [{ ...teamEndpoint, id: 's-2', scope: 'workspace', workspaceId: 'ws-1', workspaceName: 'Widgets', health: 'unknown', lastVerificationError: 'endpoint returned 502' }];
    await mount();
    expect(text('agent-endpoint-heading')).toBe('Widgets');
    expect(text('agent-endpoint-overrides')).toMatch(/Workspace endpoints/);
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

  it('Cloudflare: picks the upstream, sends a typed gateway token, and no URL or key', async () => {
    await mount();
    await click(button('Set up an endpoint'));
    await click(kindRadio(4));
    expect(host.querySelector('#agent-endpoint-key')).toBeNull();
    expect(host.querySelector('#agent-endpoint-url')).toBeNull();
    await click(host.querySelectorAll('input[name="agent-endpoint-upstream"]')[1]);
    await setValue(host.querySelector('#agent-endpoint-gateway-token') as HTMLInputElement, 'cf-gateway-run-token-example');
    await click(button('Save'));
    expect(writes[0]).toEqual({
      url: '/api/teams/t/agent-endpoint', method: 'PUT',
      body: { kind: 'cloudflare', upstream: 'openrouter', gatewayToken: 'cf-gateway-run-token-example' },
    });
    expect(host.querySelector('#agent-endpoint-gateway-token')).toBeNull();
  });

  it('a saved Cloudflare endpoint says where it goes, that a token is saved, and what is missing', async () => {
    endpoints = [{ ...teamEndpoint, kind: 'cloudflare', upstream: 'anthropic', gatewayTokenSet: true, last4: '9876', mapping: [], gatewayMissing: false, storedKeyMissing: false }];
    await mount();
    expect(text('agent-endpoint-detail')).toContain("Cloudflare AI Gateway to Anthropic, with the Anthropic key in Team keys (…9876). Gateway token saved.");
    act(() => root.unmount()); host.remove();
    endpoints = [{ ...teamEndpoint, kind: 'cloudflare', upstream: 'anthropic', mapping: [], gatewayMissing: true }];
    await mount();
    expect(text('agent-endpoint-cf-missing')).toContain('no AI Gateway ID');
  });

  it('the gateway option is disabled without a gateway, and sends only the kind with one', async () => {
    await mount();
    await click(button('Set up an endpoint'));
    expect((kindRadio(1) as HTMLInputElement).disabled).toBe(true);
    act(() => root.unmount()); host.remove();
    gateway = { baseURL: 'https://litellm.example.com/v1', last4: 'abcd' };
    await mount();
    await click(button('Set up an endpoint'));
    await click(kindRadio(1));
    await click(button('Save'));
    expect(writes[0]).toEqual({ url: '/api/teams/t/agent-endpoint', method: 'PUT', body: { kind: 'gateway' } });
  });

  it('tool search: off by default for the gateway, labelled for ToolSearch support; turning it on sends it', async () => {
    gateway = { baseURL: 'https://litellm.example.com/v1', last4: 'abcd' };
    await mount();
    await click(button('Set up an endpoint'));
    await click(kindRadio(1));
    const toggle = () => host.querySelector<HTMLInputElement>('[data-testid="agent-endpoint-tool-search-toggle"]')!;
    expect(toggle().checked).toBe(false);
    const field = text('agent-endpoint-tool-search-field');
    expect(field).toContain('deferred MCP/tool loading');
    expect(field).toContain('ToolSearch / tool_reference');
    await click(toggle());
    await click(button('Save'));
    expect(writes[0].body).toEqual({ kind: 'gateway', capabilities: { toolSearch: true } });
  });

  it('tool search: on by default for OpenRouter, sent only when turned off', async () => {
    await mount();
    await click(button('Set up an endpoint'));
    await click(kindRadio(2));
    const toggle = host.querySelector<HTMLInputElement>('[data-testid="agent-endpoint-tool-search-toggle"]')!;
    expect(toggle.checked).toBe(true);
    await setValue(host.querySelector('#agent-endpoint-key') as HTMLInputElement, KEY);
    await click(toggle);
    await click(button('Save'));
    expect(writes[0].body).toEqual({ kind: 'openrouter', apiKey: KEY, capabilities: { toolSearch: false } });
  });

  it('tool search: the saved state shows on the card and an untouched re-save leaves it alone', async () => {
    gateway = { baseURL: 'https://litellm.example.com/v1', last4: 'abcd' };
    endpoints = [{ ...teamEndpoint, kind: 'gateway', toolSearch: true, toolSearchExplicit: true }];
    await mount();
    expect(text('agent-endpoint-tool-search')).toBe('Deferred tool loading: on');
    await click(button('Edit'));
    expect(host.querySelector<HTMLInputElement>('[data-testid="agent-endpoint-tool-search-toggle"]')!.checked).toBe(true);
    await click(button('Save'));
    expect(writes.find((w) => w.method === 'PUT')!.body).not.toHaveProperty('capabilities');
  });

  it('a gateway endpoint names the gateway instead of repeating its URL and key', async () => {
    endpoints = [{ ...teamEndpoint, kind: 'gateway', baseUrl: 'https://litellm.example.com/v1', last4: 'abcd' }];
    await mount();
    expect(text('agent-endpoint-heading')).toBe('LiteLLM gateway');
    expect(text('agent-endpoint-detail')).toBe('Through the LiteLLM gateway in Team keys');
    expect(host.querySelector('[data-testid="agent-endpoint-route"]')!.textContent).not.toContain('litellm.example.com');
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

  it('the model picker shows whole ids and ranks the exact one first when searching', async () => {
    const listed = ['fireworks_ai/deepseek-v4p1-flash-long-name', 'bedrock/deepseek.r1-v1:0', 'deepseek-v4p1'];
    modelsReply = { available: true, listed, rows: ROWS };
    await openCustom();
    await act(async () => { row('claude-opus-5').querySelector('button')!.click(); });
    const search = document.querySelector<HTMLInputElement>('input[role="searchbox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'deepseek');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options[0].dataset.value).toBe('deepseek-v4p1');
    expect(options.map((o) => o.dataset.value).sort()).toEqual([...listed].sort());
    // Wrapped, not cut off with an ellipsis.
    const label = options.find((o) => o.dataset.value === listed[0])!.querySelector('span > span')!;
    expect(label.className).toContain('break-all');
    expect(label.className).not.toContain('truncate');
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

  it('OpenRouter with a key in Team keys: no key field, says which key, and saves no key', async () => {
    inferenceKeys = { providers: [{ provider: 'openrouter', team: { last4: '7777' }, mine: null }] };
    await mount();
    await click(button('Set up an endpoint'));
    await click(kindRadio(2));
    expect(host.querySelector('#agent-endpoint-key')).toBeNull();
    expect(text('agent-endpoint-stored-key')).toContain('OpenRouter key in Team keys (…7777)');
    expect((button('Save') as HTMLButtonElement).disabled).toBe(false);
    await click(button('Save'));
    expect(writes[0].body).toEqual({ kind: 'openrouter' });
  });

  it('OpenRouter with nothing in Team keys still asks for a key', async () => {
    inferenceKeys = { providers: [{ provider: 'anthropic', team: { last4: '1111' }, mine: null }] };
    await mount();
    await click(button('Set up an endpoint'));
    await click(kindRadio(2));
    expect(host.querySelector('#agent-endpoint-key')).not.toBeNull();
    expect(host.querySelector('[data-testid="agent-endpoint-stored-key"]')).toBeNull();
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a saved OpenRouter reference names Team keys; a missing key and two different keys say so', async () => {
    const or = { ...teamEndpoint, kind: 'openrouter', baseUrl: 'https://openrouter.ai/api', models: {}, mapping: [], last4: '7777' };
    endpoints = [{ ...or, keySource: 'stored' }];
    await mount();
    expect(text('agent-endpoint-detail')).toBe('With the OpenRouter key in Team keys (…7777)');
    act(() => root.unmount()); host.remove();
    endpoints = [{ ...or, keySource: 'stored', storedKeyMissing: true, last4: '' }];
    await mount();
    expect(host.textContent).toContain('Key missing');
    act(() => root.unmount()); host.remove();
    endpoints = [{ ...or, keySource: 'inline', legacyInlineKey: true, last4: '8888' }];
    await mount();
    expect(text('agent-endpoint-two-keys')).toContain('Two different OpenRouter keys');
  });

  it('teamOpenRouterKeyLast4 reads only the team-wide OpenRouter key', () => {
    expect(teamOpenRouterKeyLast4(null)).toBeNull();
    expect(teamOpenRouterKeyLast4({ providers: [{ provider: 'openrouter', team: null, mine: { last4: '1' } }] })).toBeNull();
    expect(teamOpenRouterKeyLast4({ providers: [{ provider: 'openrouter', team: { last4: 'abcd' } }] })).toBe('abcd');
  });

  it('is read-only for a member', async () => {
    endpoints = [teamEndpoint];
    await mount(false);
    expect(button('Edit')).toBeUndefined();
    expect(button('Set up an endpoint')).toBeUndefined();
    expect(button('Verify')).toBeUndefined();
    expect(button('Remove')).toBeUndefined();
  });

  it('a member reads the endpoint as text: no control beyond the mapping disclosure, no admin line', async () => {
    endpoints = [teamEndpoint, { ...teamEndpoint, id: 'c-2', scope: 'workspace', workspaceId: 'ws-1', workspaceName: 'Widgets', matchesTeam: true }];
    await mount(false);
    expect(host.querySelector('[data-testid="agent-endpoint-heading"]')).not.toBeNull();
    expect(host.textContent).toContain('Applies to:');
    expect(describeControls(host)).toEqual([]);
    expect(host.textContent).not.toMatch(/Admins can change|Only a team owner|can change this|can change the agent endpoint/);
  });

  it('a member with nothing set reads the default', async () => {
    await mount(false);
    expect(host.querySelector('[data-testid="agent-endpoint-status"]')!.textContent).toBe('Anthropic (default)');
    expect(describeControls(host)).toEqual([]);
    expect(host.textContent).not.toContain('Only a team owner');
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
    expect(text('agent-endpoint-heading')).toBe('Anthropic-compatible URL');
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

  it('the endpoint editor picks workspaces from the same checklist, never a single-select', async () => {
    endpoints = [{ ...teamEndpoint, appliesTo: null }];
    await mount(true, WORKSPACES);
    await click(button('Edit'));
    const ed = host.querySelector('[data-testid="agent-endpoint-editor"]')!;
    expect(ed.querySelector('#agent-endpoint-scope')).toBeNull();
    expect(ed.querySelectorAll('input[name="agent-endpoint-applies"]')).toHaveLength(2);
    await click(appliesRadio(1));
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true);
    await click(checkbox('ws-2'));
    await settle();
    await click(button('Save'));
    expect(writes.find((w) => w.method === 'PUT')!.body).toMatchObject({ kind: 'anthropic-compatible', appliesTo: ['ws-2'] });
  });

  it('saving the endpoint without touching its workspaces leaves the list alone', async () => {
    endpoints = [{ ...teamEndpoint, appliesTo: [{ id: 'ws-1', name: 'Widgets' }] }];
    await mount(true, WORKSPACES);
    await click(button('Edit'));
    expect(checkbox('ws-1').checked).toBe(true);
    await settle();
    await click(button('Save'));
    expect(writes.find((w) => w.method === 'PUT')!.body).not.toHaveProperty('appliesTo');
  });

  it('a workspace override is a compact row; a copy of the team endpoint says so instead of repeating it', async () => {
    endpoints = [
      { ...teamEndpoint, appliesTo: null },
      { ...teamEndpoint, id: 'c-1', scope: 'workspace', workspaceId: 'ws-1', workspaceName: 'Widgets', matchesTeam: true },
      { ...teamEndpoint, id: 'c-2', scope: 'workspace', workspaceId: 'ws-2', workspaceName: 'Gadgets', matchesTeam: false },
    ];
    await mount(true, WORKSPACES);
    const overrides = [...host.querySelectorAll<HTMLElement>('[data-testid="agent-endpoint-route"][data-scope="workspace"]')];
    expect(overrides.map((o) => o.querySelector('[data-testid="agent-endpoint-heading"]')!.textContent)).toEqual(['Widgets', 'Gadgets']);
    expect(overrides[0].textContent).toContain('Same as the team endpoint');
    expect(overrides[0].querySelector('[data-testid="agent-endpoint-mapping-summary"]')).toBeNull();
    expect(overrides[1].querySelector('[data-testid="agent-endpoint-mapping-summary"]')).not.toBeNull();
    expect(text('agent-endpoint-overrides')).toMatch(/Workspace overrides/);
  });

  it('a new override starts from the team endpoint\'s kind and aliases, not empty rows', async () => {
    gateway = { baseURL: 'https://litellm.example.com/v1', last4: 'abcd' };
    const models = { 'claude-opus-5': 'fireworks_ai/deepseek-v4p1-flash' };
    endpoints = [{ ...teamEndpoint, kind: 'gateway', baseUrl: '', last4: '', models, appliesTo: [{ id: 'ws-1', name: 'Widgets' }] }];
    modelsReply = { available: true, listed: ['fireworks_ai/deepseek-v4p1-flash'], rows: [{ model: 'claude-opus-5', tiers: ['premium'], value: 'fireworks_ai/deepseek-v4p1-flash', source: 'alias', served: true }] };
    await mount(true, WORKSPACES);
    await click(button('Add a workspace override'));
    expect(host.querySelector('#agent-endpoint-scope')!.textContent).toContain('Widgets');
    expect(text('agent-endpoint-prefill')).toBe('Starts from the team endpoint.');
    expect((kindRadio(1) as HTMLInputElement).checked).toBe(true);
    await settle();
    expect(previews.at(-1)).toEqual({ kind: 'gateway', models, workspaceId: 'ws-1' });
    expect(row('claude-opus-5').textContent).toContain('fireworks_ai/deepseek-v4p1-flash');
    await click(button('Save'));
    expect(writes.find((w) => w.method === 'PUT')!.body).toEqual({ kind: 'gateway', workspaceId: 'ws-1', models });
  });

  it('without a team endpoint, a new override starts from the latest sibling; its key is never reused', async () => {
    endpoints = [
      { ...teamEndpoint, id: 'c-1', scope: 'workspace', workspaceId: 'ws-1', workspaceName: 'Widgets', lastVerifiedAt: '2026-01-01T00:00:00.000Z' },
      { ...teamEndpoint, id: 'c-2', scope: 'workspace', workspaceId: 'ws-2', workspaceName: 'Gadgets', baseUrl: 'https://proxy.example.com', lastVerifiedAt: '2026-01-05T00:00:00.000Z' },
    ];
    await mount(true, WORKSPACES);
    await click(button('Add a workspace override'));
    expect(host.querySelector('#agent-endpoint-scope')!.textContent).toContain('Sprockets');
    expect(text('agent-endpoint-prefill')).toBe('Starts from Gadgets.');
    expect((host.querySelector('#agent-endpoint-url') as HTMLInputElement).value).toBe('https://proxy.example.com');
    const key = host.querySelector('#agent-endpoint-key') as HTMLInputElement;
    expect(key.placeholder).toBe('sk-…');
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true);
    await setValue(key, KEY);
    await settle();
    expect(previews.at(-1)).toMatchObject({ baseUrl: 'https://proxy.example.com', models: teamEndpoint.models, workspaceId: 'ws-3' });
    await click(button('Save'));
    expect(writes.find((w) => w.method === 'PUT')!.body).toMatchObject({ workspaceId: 'ws-3', apiKey: KEY, models: teamEndpoint.models });
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

/**
 * A connector's tool list (happy-dom): class and source per tool, and the
 * admin's read-only / deny toggles saving the whole toolPolicy through the
 * session-only PATCH. A member sees no toggles.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/apps' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ConnectorToolsPanel } = await import('./ConnectorToolsPanel');

const CONN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const row = (name: string, over: object = {}) => ({ name, cls: 'write', source: 'default', adminReadOnly: false, adminDenied: false, listed: true, refused: false, ...over });
const DATA = {
  canManage: true,
  snapshotAt: '2026-11-25T00:00:00.000Z',
  tools: [
    row('list-things', { cls: 'read', source: 'provider' }),
    row('otel-new', { refused: true }),
    row('otel-x', { cls: 'read', source: 'admin', adminReadOnly: true }),
  ],
};

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; method?: string; body: any }[];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: true, status: 200, json: async () => (init?.method ? { connector: { id: CONN } } : DATA) } as Response;
  }) as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const $ = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement | null;

describe('ConnectorToolsPanel', () => {
  it('lists each tool with its class and where it came from', async () => {
    act(() => root.render(<ConnectorToolsPanel connectorId={CONN} appName="Axiom" />));
    await flush();
    expect(calls[0].url).toBe(`/api/connectors/${CONN}/tools`);
    expect($('connector-tool-class-list-things')!.textContent).toBe('read');
    expect($('connector-tool-source-list-things')!.textContent).toBe('Provider annotation');
    expect($('connector-tool-class-otel-new')!.textContent).toBe('write');
    expect($('connector-tool-source-otel-new')!.textContent).toBe('Not annotated');
    expect($('connector-tool-source-otel-x')!.textContent).toBe('Admin override');
    expect($('connector-tool-readonly-otel-x')!.checked).toBe(true);
  });

  it('Read-only saves the whole policy with the tool added', async () => {
    act(() => root.render(<ConnectorToolsPanel connectorId={CONN} appName="Axiom" />));
    await flush();
    await act(async () => { $('connector-tool-readonly-otel-new')!.click(); });
    await flush();
    const patch = calls.find(c => c.method === 'PATCH')!;
    expect(patch.url).toBe(`/api/connectors/${CONN}`);
    expect(patch.body).toEqual({ toolPolicy: { readOnlyTools: ['otel-new', 'otel-x'], denyTools: [] } });
  });

  it('Deny adds the tool to denyTools; unticking read-only removes it', async () => {
    act(() => root.render(<ConnectorToolsPanel connectorId={CONN} appName="Axiom" />));
    await flush();
    await act(async () => { $('connector-tool-deny-list-things')!.click(); });
    await flush();
    expect(calls.filter(c => c.method === 'PATCH')[0].body).toEqual({ toolPolicy: { readOnlyTools: ['otel-x'], denyTools: ['list-things'] } });
    await act(async () => { $('connector-tool-readonly-otel-x')!.click(); });
    await flush();
    expect(calls.filter(c => c.method === 'PATCH')[1].body.toolPolicy.readOnlyTools).toEqual([]);
  });

  it('a member reads the list without toggles', () => {
    act(() => root.render(<ConnectorToolsPanel connectorId={CONN} appName="Axiom" initial={{ ...DATA, canManage: false } as any} />));
    expect($('connector-tool-class-otel-new')).not.toBeNull();
    expect($('connector-tool-readonly-otel-new')).toBeNull();
    expect($('connector-tool-deny-otel-new')).toBeNull();
  });
});

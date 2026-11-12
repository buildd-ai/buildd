/**
 * The knowledge ingest switch (workspaces.knowledge_ingest) and the separate
 * "Delete indexed content" action. Switching off must never purge.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1', width: 1280, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: KnowledgeIngestSection } = await import('./KnowledgeIngestSection');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof mock>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = mock(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify(body.purgeKnowledge ? { success: true, purgedChunks: 42 } : { success: true }), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

const sw = () => host.querySelector('[role="switch"]') as HTMLButtonElement;
const body = (i: number) => JSON.parse(String((fetchMock.mock.calls[i] as [string, RequestInit])[1].body));
const buttonByText = (text: string) =>
  [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe('KnowledgeIngestSection', () => {
  it('switching off sends knowledgeIngest: false and nothing else', async () => {
    act(() => root.render(<KnowledgeIngestSection workspaceId="ws-1" initial={true} canEdit={true} />));
    expect(sw().getAttribute('aria-checked')).toBe('true');
    await act(async () => { sw().click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body(0)).toEqual({ knowledgeIngest: false });
    expect(sw().getAttribute('aria-checked')).toBe('false');
  });

  it('deleting indexed content is its own confirmed action', async () => {
    act(() => root.render(<KnowledgeIngestSection workspaceId="ws-1" initial={false} canEdit={true} />));
    const open = host.querySelector('[data-testid="knowledge-purge-button"]') as HTMLButtonElement;
    await act(async () => { open.click(); });
    // Opening the dialog sends nothing.
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { buttonByText('Delete')!.click(); });
    expect(body(0)).toEqual({ purgeKnowledge: true });
    expect(host.textContent).toContain('Deleted 42 indexed pieces of content.');
  });

  it('a failed save puts the switch back and says so', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Requires workspace admin' }), { status: 403 }));
    act(() => root.render(<KnowledgeIngestSection workspaceId="ws-1" initial={true} canEdit={true} />));
    await act(async () => { sw().click(); });
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Requires workspace admin');
  });

  it('read-only: shows the state, no switch and no delete', () => {
    act(() => root.render(<KnowledgeIngestSection workspaceId="ws-1" initial={false} canEdit={false} />));
    expect(sw()).toBeNull();
    expect(host.querySelector('[data-testid="knowledge-ingest-value"]')?.textContent).toBe('Off');
    expect(host.querySelector('[data-testid="knowledge-purge-button"]')).toBeNull();
  });
});

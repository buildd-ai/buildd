/**
 * The workspace's "Fix until CI passes" switch (gitConfig.enforceGreenCI),
 * moved here from the Settings → Workspaces list. Fixtures are illustrative.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1', width: 1280, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: CiRetrySection } = await import('./CiRetrySection');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof mock>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = mock(async () => new Response('{}', { status: 200 }));
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

describe('CiRetrySection', () => {
  it('is anchored for the list chip and shows the stored value', () => {
    act(() => root.render(<CiRetrySection workspaceId="ws-1" initial={true} canEdit={true} />));
    expect(host.querySelector('#ci-retry')).not.toBeNull();
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('PATCHes the workspace gitConfig', async () => {
    act(() => root.render(<CiRetrySection workspaceId="ws-1" initial={false} canEdit={true} />));
    await act(async () => { sw().click(); });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspaces/ws-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ gitConfig: { enforceGreenCI: true } });
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('rolls back and says why when the save fails', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
    act(() => root.render(<CiRetrySection workspaceId="ws-1" initial={true} canEdit={true} />));
    await act(async () => { sw().click(); });
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain('Forbidden');
  });

  it('reads as text, with no switch, for someone who cannot edit the workspace', () => {
    act(() => root.render(<CiRetrySection workspaceId="ws-1" initial={false} canEdit={false} />));
    expect(sw()).toBeNull();
    expect(host.querySelector('[data-testid="ci-retry-value"]')!.textContent).toBe('Off');
  });
});

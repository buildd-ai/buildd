/**
 * The workspace's warm handover opt-out (gitConfig.warmHandover: 'off'). The
 * platform decides everything else; on is 'off', off clears it to null.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1', width: 1280, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: FreshContainerSection } = await import('./FreshContainerSection');

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
const body = (i: number) => JSON.parse(String((fetchMock.mock.calls[i] as [string, RequestInit])[1].body));

describe('FreshContainerSection', () => {
  it('turning it on opts the workspace out; turning it off clears the opt-out', async () => {
    act(() => root.render(<FreshContainerSection workspaceId="ws-1" initial={false} canEdit={true} />));
    expect(sw().getAttribute('aria-checked')).toBe('false');
    await act(async () => { sw().click(); });
    expect(body(0)).toEqual({ gitConfig: { warmHandover: 'off' } });
    expect(sw().getAttribute('aria-checked')).toBe('true');
    await act(async () => { sw().click(); });
    expect(body(1)).toEqual({ gitConfig: { warmHandover: null } });
  });

  it('rolls back and says why when the save fails', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
    act(() => root.render(<FreshContainerSection workspaceId="ws-1" initial={true} canEdit={true} />));
    await act(async () => { sw().click(); });
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain('Forbidden');
  });

  it('reads as text, with no switch, for someone who cannot edit the workspace', () => {
    act(() => root.render(<FreshContainerSection workspaceId="ws-1" initial={true} canEdit={false} />));
    expect(sw()).toBeNull();
    expect(host.querySelector('[data-testid="fresh-container-value"]')!.textContent).toBe('On');
  });
});

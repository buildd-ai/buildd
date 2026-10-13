/**
 * Mission pull requests (gitConfig.branchStrategy). Settings spec R-3: named
 * apart from Repository's Git workflow. R-4: a segmented choice on its own
 * saves when picked, with no Save button.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1', width: 1280, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: BranchStrategySection } = await import('./BranchStrategySection');

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

const radio = (label: string) =>
  [...host.querySelectorAll('[role="radio"]')].find(r => r.textContent?.trim() === label) as HTMLElement;

describe('BranchStrategySection', () => {
  it('is labelled Mission pull requests, with one option per PR shape', () => {
    act(() => root.render(<BranchStrategySection workspaceId="ws-1" effectiveBranchStrategy="mission-branch" defaultBranch="dev" canEdit />));
    expect(host.textContent).toContain('Mission pull requests');
    expect(host.textContent).not.toContain('Branch strategy');
    expect(radio('One PR per mission')).toBeTruthy();
    expect(radio('One PR per task')).toBeTruthy();
  });

  it('saves the choice when picked, with no Save button', async () => {
    act(() => root.render(<BranchStrategySection workspaceId="ws-1" effectiveBranchStrategy="mission-branch" defaultBranch="dev" canEdit />));
    expect([...host.querySelectorAll('button')].some(b => /save/i.test(b.textContent ?? ''))).toBe(false);
    await act(async () => { radio('One PR per task').click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspaces/ws-1/config');
    expect(JSON.parse(String(init.body))).toEqual({ branchStrategy: 'direct' });
  });

  it('goes back to the stored choice when the save fails', async () => {
    fetchMock = mock(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    act(() => root.render(<BranchStrategySection workspaceId="ws-1" effectiveBranchStrategy="mission-branch" defaultBranch="dev" canEdit />));
    await act(async () => { radio('One PR per task').click(); });
    expect(radio('One PR per mission').getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain('nope');
  });
});

/**
 * Pause new starts, on the workspace's own settings page (Where work runs). It
 * moved here from Health › Runners, which now only shows a pause. Same
 * POST /api/workspaces/[id]/pause-starts.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: PauseStartsSection } = await import('./PauseStartsSection');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined;

describe('PauseStartsSection', () => {
  it('pauses this workspace for the chosen time', async () => {
    await act(async () => { root.render(<PauseStartsSection workspaceId="ws-1" pausedUntil={null} canEdit />); });
    expect(host.textContent).toContain('Pause new starts');
    await act(async () => { button('1 hour')!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toEqual([{ url: '/api/workspaces/ws-1/pause-starts', body: { for: '1h' } }]);
  });

  it('while paused, says until when and resumes', async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await act(async () => { root.render(<PauseStartsSection workspaceId="ws-1" pausedUntil={until} canEdit />); });
    expect(host.querySelector('[data-testid="pause-starts-value"]')!.textContent).toMatch(/^Paused until /);
    expect(button('1 hour')).toBeUndefined();
    await act(async () => { button('Resume')!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toEqual([{ url: '/api/workspaces/ws-1/pause-starts', body: { until: null } }]);
  });
});

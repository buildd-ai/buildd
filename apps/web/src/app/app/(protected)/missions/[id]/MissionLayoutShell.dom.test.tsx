/**
 * MissionLayoutShell, mounted (happy-dom): the server builds only the layout
 * on screen (spec 3ef37387 R-18), so a tab whose layout was never sent asks
 * the server for it (one `router.refresh`, the URL already names it), and a
 * layout the shell has shown before switches back with no request.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerCalls: string[] = [];
mock.module('next/navigation', () => ({
  useRouter: () => ({
    push: () => routerCalls.push('push'),
    replace: () => routerCalls.push('replace'),
    refresh: () => routerCalls.push('refresh'),
    back: () => {},
    prefetch: () => {},
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => window.location.pathname,
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionLayoutShell, MissionLayoutTabs } = await import('./MissionLayoutShell');

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
  routerCalls.length = 0;
  window.history.replaceState(null, '', '/app/missions/m1');
});

function slot(name: string) {
  return createElement('div', { 'data-testid': `slot-${name}` }, createElement(MissionLayoutTabs));
}

function tab(layout: string): HTMLButtonElement {
  return host!.querySelector(`[role="tab"][data-layout="${layout}"]`) as HTMLButtonElement;
}

describe('MissionLayoutShell builds one layout at a time (R-18)', () => {
  it('a tab the server never built asks for it once; a layout already shown switches back without asking', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (props: { initial: 'board' | 'flow' | 'feed'; board: unknown; flow: unknown; feed: unknown }) =>
      act(() => root.render(createElement(MissionLayoutShell, props as never)));

    await render({ initial: 'board', board: slot('board'), flow: null, feed: null });
    expect(host.querySelector('[data-testid="slot-board"]')).not.toBeNull();

    await act(async () => { tab('flow').click(); });
    expect(window.location.search).toBe('?layout=flow');
    expect(routerCalls).toEqual(['refresh']);
    // Until the server answers, the panel says it is loading, not blank.
    expect(host.querySelector('[data-testid="mission-layout-loading"]')).not.toBeNull();

    // The refreshed render carries Flow only.
    await render({ initial: 'flow', board: null, flow: slot('flow'), feed: null });
    expect(host.querySelector('[data-testid="slot-flow"]')).not.toBeNull();

    // Back to Overview: shown before, so no second request.
    await act(async () => { tab('board').click(); });
    expect(host.querySelector('[data-testid="slot-board"]')).not.toBeNull();
    expect(routerCalls).toEqual(['refresh']);
    await act(async () => root.unmount());
  });
});

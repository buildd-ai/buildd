/**
 * MissionLayoutShell, mounted (happy-dom): the server builds only the layout
 * on screen (spec 3ef37387 R-18), so a switch to a layout never sent asks
 * the server for it (one `router.refresh`, the URL already names it), and a
 * layout the shell has shown before switches back with no request.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerCalls: string[] = [];
/**
 * The URL the App Router holds. `router.refresh()` renders this one, not the
 * address bar, and a native write only reaches it through Next's patched
 * `replaceState`, modelled below with its loop guard (the property is pinned
 * against the installed source in TaskSheet.next-history.test.ts).
 */
let routerUrl = '/app/missions/m1';
const nativeReplaceState = window.history.replaceState.bind(window.history);
window.history.replaceState = function replaceState(data: unknown, unused: string, url?: string | URL | null) {
  const d = data as { __NA?: unknown; _N?: unknown } | null;
  if (!(d?.__NA || d?._N) && url) routerUrl = String(url);
  return nativeReplaceState({ ...(data as object ?? {}), __NA: true }, unused, url);
};
mock.module('next/navigation', () => ({
  useRouter: () => ({
    push: () => routerCalls.push('push'),
    replace: () => routerCalls.push('replace'),
    refresh: () => routerCalls.push(`refresh ${routerUrl}`),
    back: () => {},
    prefetch: () => {},
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => window.location.pathname,
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionLayoutShell, useMissionLayout } = await import('./MissionLayoutShell');

/** What the ⋯ menu's History and Flow rows do: switch the layout through the shell. */
function Switch() {
  const ctx = useMissionLayout();
  if (!ctx) return null;
  return createElement('div', null, ...(['board', 'flow', 'feed'] as const).map(l => createElement('button', { key: l, type: 'button', 'data-switch': l, onClick: () => ctx.setLayout(l) }, l)));
}

let host: HTMLDivElement | null = null;
beforeEach(() => {
  routerUrl = '/app/missions/m1';
  nativeReplaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: {} }, '', '/app/missions/m1');
});
afterEach(() => {
  host?.remove();
  host = null;
  routerCalls.length = 0;
  window.history.replaceState(null, '', '/app/missions/m1');
  // As after hydration: the entry carries Next's own markers.
  nativeReplaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: {} }, '', '/app/missions/m1');
});

function slot(name: string) {
  return createElement('div', { 'data-testid': `slot-${name}` }, createElement(Switch));
}

function tab(layout: string): HTMLButtonElement {
  return host!.querySelector(`button[data-switch="${layout}"]`) as HTMLButtonElement;
}

describe('a Flow link below md lands on the mission page (spec d25d923d R-2)', () => {
  it('at 390px, ?layout=flow switches to Overview and asks for it; at desktop width it stays Flow', async () => {
    const realMatch = window.matchMedia;
    const run = async (phone: boolean) => {
      window.matchMedia = ((q: string) => ({ matches: phone && q === '(max-width: 767.98px)', media: q, addEventListener() {}, removeEventListener() {} })) as never;
      nativeReplaceState({ __NA: true }, '', '/app/missions/m1?layout=flow');
      routerUrl = '/app/missions/m1?layout=flow';
      host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => root.render(createElement(MissionLayoutShell, { initial: 'flow', board: null, flow: slot('flow'), feed: null })));
      const out = { layout: host.querySelector('[data-testid="mission-layout"]')?.getAttribute('data-layout'), search: window.location.search, calls: [...routerCalls] };
      await act(async () => root.unmount());
      host.remove();
      host = null;
      routerCalls.length = 0;
      return out;
    };
    try {
      expect(await run(true)).toEqual({ layout: 'board', search: '', calls: ['refresh /app/missions/m1'] });
      expect(await run(false)).toEqual({ layout: 'flow', search: '?layout=flow', calls: [] });
    } finally {
      window.matchMedia = realMatch;
    }
  });
});

describe('MissionLayoutShell builds one layout at a time (R-18)', () => {
  it('a layout the server never built asks for it once; a layout already shown switches back without asking', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (props: { initial: 'board' | 'flow' | 'feed'; board: unknown; flow: unknown; feed: unknown }) =>
      act(() => root.render(createElement(MissionLayoutShell, props as never)));

    await render({ initial: 'board', board: slot('board'), flow: null, feed: null });
    expect(host.querySelector('[data-testid="slot-board"]')).not.toBeNull();

    await act(async () => { tab('flow').click(); });
    expect(window.location.search).toBe('?layout=flow');
    // The router saw the write, so the refresh builds Flow, not Overview again.
    expect(routerCalls).toEqual(['refresh /app/missions/m1?layout=flow']);
    // Until the server answers, the panel says it is loading, not blank.
    expect(host.querySelector('[data-testid="mission-layout-loading"]')).not.toBeNull();

    // The refreshed render carries Flow only.
    await render({ initial: 'flow', board: null, flow: slot('flow'), feed: null });
    expect(host.querySelector('[data-testid="slot-flow"]')).not.toBeNull();

    // Back to Overview: shown before, so no second request.
    await act(async () => { tab('board').click(); });
    expect(host.querySelector('[data-testid="slot-board"]')).not.toBeNull();
    expect(routerCalls).toEqual(['refresh /app/missions/m1?layout=flow']);
    await act(async () => root.unmount());
  });

  it('a layout that does not arrive says so and offers a retry, never an endless loading line', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const timers: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => { timers.push(fn); return timers.length as never; }) as never;
    try {
      await act(async () => root.render(createElement(MissionLayoutShell, { initial: 'board', board: slot('board'), flow: null, feed: null })));
      await act(async () => { tab('feed').click(); });
      expect(routerCalls).toEqual(['refresh /app/missions/m1?layout=feed']);
      expect(host.querySelector('[data-testid="mission-layout-error"]')).toBeNull();

      expect(timers.length).toBe(1);
      await act(async () => { timers.splice(0).forEach(fn => fn()); });
      const error = host.querySelector('[data-testid="mission-layout-error"]');
      expect(error?.textContent).toContain('History');
      expect(host.querySelector('[data-testid="mission-layout-loading"]')).toBeNull();

      await act(async () => { (host!.querySelector('[data-testid="mission-layout-retry"]') as HTMLButtonElement).click(); });
      expect(routerCalls).toEqual(['refresh /app/missions/m1?layout=feed', 'refresh /app/missions/m1?layout=feed']);
      expect(host.querySelector('[data-testid="mission-layout-loading"]')).not.toBeNull();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      await act(async () => root.unmount());
    }
  });
});

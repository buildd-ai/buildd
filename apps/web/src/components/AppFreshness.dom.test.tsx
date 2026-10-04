/**
 * AppFreshness mounted (happy-dom) with a mocked router and Pusher connection:
 *
 * - Return from the background with NO realtime event → exactly one
 *   router.refresh() and one catch-up notification, however many of
 *   visibilitychange / focus / pageshow the browser fires.
 * - A Pusher reconnect right after that → no second immediate refresh.
 * - A pull from the top of the scroll root → one refresh, the touchmove is
 *   claimed, and the indicator reports progress then "Up to date".
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/home' });

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let refreshes = 0;
mock.module('next/navigation', () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => { refreshes++; },
    back: () => {},
    prefetch: () => {},
  }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

type StateHandler = (s: { previous: string; current: string }) => void;
let stateHandlers: StateHandler[] = [];
mock.module('@/lib/pusher-client', () => ({
  CHANNEL_PREFIX: '',
  getPusherClient: () => ({
    connection: {
      bind: (_: string, fn: StateHandler) => { stateHandlers.push(fn); },
      unbind: (_: string, fn: StateHandler) => { stateHandlers = stateHandlers.filter(f => f !== fn); },
    },
  }),
  subscribeToChannel: () => null,
  unsubscribeFromChannel: () => {},
  getSubscribedChannel: () => null,
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: AppFreshness } = await import('./AppFreshness');
const { subscribeCatchUp, CATCH_UP_WINDOW_MS } = await import('@/lib/app-freshness');

let now = 1_000_000;
let hidden = false;
let main: HTMLElement;
let root: ReturnType<typeof createRoot>;
let catchUps: string[] = [];
let offCatchUp: () => void;
spyOn(Date, 'now').mockImplementation(() => now);

Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });

function pusher(previous: string, current: string) {
  act(() => { for (const fn of stateHandlers) fn({ previous, current }); });
}

function touch(type: string, y: number, x = 100) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const list = type === 'touchend' ? [] : [{ clientX: x, clientY: y }];
  Object.defineProperty(e, 'touches', { value: list });
  act(() => { main.dispatchEvent(e); });
  return e;
}

beforeEach(() => {
  refreshes = 0;
  catchUps = [];
  hidden = false;
  stateHandlers = [];
  main = document.createElement('main');
  main.setAttribute('data-scroll-root', '');
  document.body.appendChild(main);
  const container = document.createElement('div');
  main.appendChild(container);
  offCatchUp = subscribeCatchUp((r) => catchUps.push(r));
  root = createRoot(container);
  act(() => root.render(createElement(AppFreshness)));
});

afterEach(() => {
  act(() => root.unmount());
  offCatchUp();
  main.remove();
});

describe('resume / reconnect', () => {
  it('backgrounded and back, no realtime event: one catch-up for the whole burst', () => {
    now += CATCH_UP_WINDOW_MS;
    hidden = true;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    now += 5 * 60_000;
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(refreshes).toBe(1);
    expect(catchUps).toEqual(['resume']);

    // The socket comes back a few seconds later: no second immediate render.
    now += 3_000;
    pusher('connected', 'connecting');
    pusher('connecting', 'connected');
    expect(refreshes).toBe(1);
  });

  it('a Pusher reconnect on a long-open tab catches up once', () => {
    now += CATCH_UP_WINDOW_MS;
    pusher('initialized', 'connecting');
    pusher('connecting', 'connected'); // first connect is not a reconnect
    expect(refreshes).toBe(0);
    pusher('connected', 'unavailable');
    pusher('unavailable', 'connected');
    expect(refreshes).toBe(1);
  });

  it('desktop focus churn on a fresh view does nothing', () => {
    for (let i = 0; i < 10; i++) {
      now += 1_000;
      act(() => { window.dispatchEvent(new Event('focus')); });
    }
    expect(refreshes).toBe(0);
  });
});

describe('pull-to-refresh', () => {
  it('pulling down from the top refreshes and shows progress', async () => {
    touch('touchstart', 100);
    const move = touch('touchmove', 100 + 200);
    expect(move.defaultPrevented).toBe(true);
    const indicator = () => document.querySelector('[data-testid="pull-refresh-indicator"]');
    expect(indicator()?.getAttribute('data-phase')).toBe('pulling');
    expect(indicator()?.textContent).toContain('Release to refresh');

    touch('touchend', 0);
    expect(refreshes).toBe(1);
    expect(catchUps).toEqual(['pull']);
    // The mocked refresh is synchronous, so its transition has already settled.
    await act(async () => {});
    expect(document.querySelector('[data-testid="pull-refresh-status"]')?.textContent).toBe('Up to date');
  });

  it('a pull while scrolled down is an ordinary scroll', () => {
    Object.defineProperty(main, 'scrollTop', { configurable: true, value: 200 });
    touch('touchstart', 100);
    const move = touch('touchmove', 300);
    touch('touchend', 0);
    expect(move.defaultPrevented).toBe(false);
    expect(refreshes).toBe(0);
    delete (main as { scrollTop?: number }).scrollTop;
  });

  it('a short pull springs back without refreshing', () => {
    touch('touchstart', 100);
    touch('touchmove', 140);
    touch('touchend', 0);
    expect(refreshes).toBe(0);
    expect(document.querySelector('[data-testid="pull-refresh-indicator"]')).toBeNull();
  });
});

/**
 * The conversation drains its fired watches on open and when the tab comes
 * back, never from a hidden tab, and refetches only when something landed.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/chat/c-1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useWatchDelivery } = await import('./use-watch-delivery');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let posts: string[] = [];
let delivered = 0;
let refetches = 0;
let visibility: 'visible' | 'hidden' = 'visible';

Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

function Probe({ id }: { id: string | null }) {
  useWatchDelivery(id, () => { refetches += 1; });
  return null;
}

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

beforeEach(() => {
  posts = []; delivered = 0; refetches = 0; visibility = 'visible';
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    posts.push(`${init?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify({ delivered }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useWatchDelivery', () => {
  it('drains once on open; refetches only when something was delivered', async () => {
    await act(async () => { root.render(<Probe id="c-1" />); });
    await flush();
    expect(posts).toEqual(['POST /api/chat/c-1/deliveries']);
    expect(refetches).toBe(0);

    delivered = 1;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(posts).toHaveLength(2);
    expect(refetches).toBe(1);
  });

  it('a hidden tab never polls', async () => {
    visibility = 'hidden';
    await act(async () => { root.render(<Probe id="c-1" />); });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(posts).toEqual([]);
  });

  it('no conversation yet: nothing to drain', async () => {
    await act(async () => { root.render(<Probe id={null} />); });
    await flush();
    expect(posts).toEqual([]);
  });
});

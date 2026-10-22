/**
 * The Flow / History tabs against Next's real router reducer.
 *
 * A tab the server has not built writes `?layout=` with a native
 * `replaceState` and then calls `router.refresh()`. The refresh renders
 * whatever URL the router holds (`state.canonicalUrl`), not the address bar.
 * So the tab only loads if the native write reached the router (ACTION_RESTORE).
 * When it does not (the write passed `history.state`, whose `__NA` marker
 * trips the patch's loop guard), the refresh re-renders Overview and the tab
 * shows "Loading Flow…" for good. That was the bug.
 *
 * The harness mirrors TaskSheet.next-history.test.ts; it runs in its own
 * process (scripts/run-unit-tests.ts).
 */
import { describe, expect, it, mock } from 'bun:test';

const fetchCalls: string[] = [];

mock.module('react-server-dom-webpack/client', () => ({
  createFromFetch: () => new Promise(() => {}),
  createFromReadableStream: () => new Promise(() => {}),
  createTemporaryReferenceSet: () => ({}),
  encodeReply: async () => '',
}));

const ORIGIN = 'https://example.test';
const g = globalThis as Record<string, unknown>;
g.fetch = (url: unknown) => {
  fetchCalls.push(String(url));
  return new Promise(() => {});
};
g.location = new URL(`${ORIGIN}/app/missions/m1`);
g.window = globalThis;
g.document = { documentElement: { dataset: {} }, getElementById: () => null };

/* eslint-disable @typescript-eslint/no-require-imports */
const { createInitialRouterState } = require('next/dist/client/components/router-reducer/create-initial-router-state');
const { reducer } = require('next/dist/client/components/router-reducer/router-reducer');
const { ACTION_RESTORE, ACTION_REFRESH } = require('next/dist/client/components/router-reducer/router-reducer-types');
/* eslint-enable @typescript-eslint/no-require-imports */

type RouterState = { canonicalUrl: string; renderedSearch: string; tree: unknown };

function initialState(): RouterState {
  const seed = (node: unknown, kids: Record<string, unknown>) => [node, kids, null, false, null];
  const tree = [
    '',
    { children: ['app', { children: ['missions', { children: [['id', 'm1', 'd', null], { children: ['__PAGE__', {}] }] }] }] },
    null,
    null,
    true,
  ];
  const seedData = seed('root', { children: seed('app', { children: seed('missions', { children: seed('id', { children: seed('page', {}) }) }) }) });
  return createInitialRouterState({
    navigatedAt: Date.now(),
    initialRSCPayload: { c: ['', 'app', 'missions', 'm1'], f: [[tree, seedData, null, false]], q: '', i: false, S: false },
    initialFlightStreamForCache: null,
    location: g.location,
  });
}

const settle = () => new Promise(r => setTimeout(r, 30));
const rscFetches = () => fetchCalls.filter(u => u.includes('/app/missions/m1') && u.includes('_rsc='));

describe('Flow / History tab: the refresh renders the layout the tab names', () => {
  it('a synced native write (ACTION_RESTORE) makes router.refresh() fetch ?layout=flow', async () => {
    fetchCalls.length = 0;
    const s0 = initialState();
    const s1 = await reducer(s0, {
      type: ACTION_RESTORE,
      url: new URL('/app/missions/m1?layout=flow', ORIGIN),
      historyState: { tree: s0.tree, renderedSearch: s0.renderedSearch },
    });
    reducer(s1, { type: ACTION_REFRESH });
    await settle();

    const fetched = rscFetches();
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every(u => new URL(u, ORIGIN).searchParams.get('layout') === 'flow')).toBe(true);
  });

  it('control: a write the router never saw leaves refresh on the old URL (Overview again)', async () => {
    fetchCalls.length = 0;
    reducer(initialState(), { type: ACTION_REFRESH });
    await settle();

    const fetched = rscFetches();
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.some(u => new URL(u, ORIGIN).searchParams.get('layout') === 'flow')).toBe(false);
  });
});

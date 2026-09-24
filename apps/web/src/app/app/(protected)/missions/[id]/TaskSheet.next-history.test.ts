/**
 * The crux gate for the task sheet (docs/design/mission-feed-mobile-continuity.md,
 * "Crux", slice S4 "First test").
 *
 * The sheet is driven by `?task=` written with native `history.pushState` /
 * `replaceState`, never `router.push` / `router.replace`. That only works if,
 * on the Next build this repo actually installs:
 *
 *   1. the App Router patches `pushState`/`replaceState` so the pushed URL
 *      reaches `useSearchParams` (it dispatches ACTION_RESTORE), and
 *   2. ACTION_RESTORE updates the router's canonical URL — which is what
 *      `useSearchParams` reads — WITHOUT an RSC fetch, while the
 *      `router.replace` path (ACTION_NAVIGATE) does fetch.
 *
 * (2) is exercised against Next's real reducer with a spy on `fetch`; the
 * control case proves the spy can fail. (1) lives inside the AppRouter's
 * effect, which needs a DOM to mount, so it is pinned as a property of the
 * installed source (docs: pin the property, not the version). If either
 * breaks after a Next bump, the fallback is the intercepting-route slot in the
 * design's Open questions — do not paper over it here.
 */
import { describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';

const fetchCalls: string[] = [];

// Next aliases this to its compiled copy at build time; outside the bundler it
// is unresolvable. A stub is enough: the only path that reaches it is a real
// RSC fetch, which the global fetch spy below records first.
mock.module('react-server-dom-webpack/client', () => ({
  createFromFetch: () => {
    fetchCalls.push('createFromFetch');
    return new Promise(() => {});
  },
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
g.location = new URL(`${ORIGIN}/app/missions/m1?from=home`);
g.window = globalThis;
g.document = { documentElement: { dataset: {} }, getElementById: () => null };

// Required (not imported) so the globals above exist when Next's modules load.
/* eslint-disable @typescript-eslint/no-require-imports */
const { createInitialRouterState } = require('next/dist/client/components/router-reducer/create-initial-router-state');
const { reducer } = require('next/dist/client/components/router-reducer/router-reducer');
const { ACTION_RESTORE, ACTION_NAVIGATE } = require('next/dist/client/components/router-reducer/router-reducer-types');
/* eslint-enable @typescript-eslint/no-require-imports */

type RouterState = { canonicalUrl: string; renderedSearch: string; tree: unknown };

/** A hydrated router state for `/app/missions/m1?from=home`, as the SSR payload would seed it. */
function initialState(): RouterState {
  const seed = (node: unknown, kids: Record<string, unknown>) => [node, kids, null, false, null];
  const tree = [
    '',
    { children: ['app', { children: ['missions', { children: [['id', 'm1', 'd', null], { children: ['__PAGE__?{"from":"home"}', {}] }] }] }] },
    null,
    null,
    true,
  ];
  const seedData = seed('root', { children: seed('app', { children: seed('missions', { children: seed('id', { children: seed('page', {}) }) }) }) });
  return createInitialRouterState({
    navigatedAt: Date.now(),
    initialRSCPayload: { c: ['', 'app', 'missions', 'm1?from=home'], f: [[tree, seedData, null, false]], q: '?from=home', i: false, S: false },
    initialFlightStreamForCache: null,
    location: g.location,
  });
}

/** What the patched `pushState`/`replaceState` dispatches for `url`. */
async function restore(state: RouterState, url: string): Promise<RouterState> {
  return reducer(state, {
    type: ACTION_RESTORE,
    url: new URL(url, ORIGIN),
    // copyNextJsInternalHistoryState carries the current tree into the new entry.
    historyState: { tree: state.tree, renderedSearch: state.renderedSearch },
  });
}

const settle = () => new Promise(r => setTimeout(r, 30));

/** `useSearchParams()` is `new URL(canonicalUrl).searchParams` (app-router.js). */
const searchParamsOf = (state: RouterState) => new URL(state.canonicalUrl, ORIGIN).searchParams;

describe('crux: native history writes sync useSearchParams without an RSC fetch', () => {
  it('pushState(?task=) → useSearchParams has task, and nothing is fetched', async () => {
    fetchCalls.length = 0;
    const s0 = initialState();
    expect(searchParamsOf(s0).get('task')).toBeNull();

    const s1 = await restore(s0, '/app/missions/m1?from=home&task=t1');
    await settle();

    expect(searchParamsOf(s1).get('task')).toBe('t1');
    expect(searchParamsOf(s1).get('from')).toBe('home');
    // The server render was not re-requested: the rendered search is still the
    // one the page was built with, and no request left the client.
    expect(s1.renderedSearch).toBe(s0.renderedSearch);
    expect(fetchCalls).toEqual([]);
  });

  it('replaceState(?task=next) steps, and a close back to no task, are fetch-free too', async () => {
    fetchCalls.length = 0;
    const s1 = await restore(initialState(), '/app/missions/m1?from=home&task=t1');
    const s2 = await restore(s1, '/app/missions/m1?from=home&task=t2');
    const s3 = await restore(s2, '/app/missions/m1?from=home#t-t2');
    await settle();

    expect(searchParamsOf(s2).get('task')).toBe('t2');
    expect(searchParamsOf(s3).get('task')).toBeNull();
    // The hash is kept in the canonical URL, so a later router.refresh()
    // (whose history write replays canonicalUrl) does not strip the focus.
    expect(s3.canonicalUrl).toBe('/app/missions/m1?from=home#t-t2');
    expect(fetchCalls).toEqual([]);
  });

  it('control: router.replace(?task=) — ACTION_NAVIGATE — DOES fetch the RSC payload', async () => {
    fetchCalls.length = 0;
    reducer(initialState(), {
      type: ACTION_NAVIGATE,
      url: new URL('/app/missions/m1?from=home&task=t1', ORIGIN),
      isExternalUrl: false,
      locationSearch: '',
      navigateType: 'replace',
      shouldScroll: false,
      allowAliasing: true,
    });
    await settle();

    expect(fetchCalls.some(u => u.includes('/app/missions/m1') && u.includes('_rsc='))).toBe(true);
  });
});

describe('crux: the installed App Router routes native history writes into ACTION_RESTORE', () => {
  const src = readFileSync(require.resolve('next/dist/client/components/app-router.js'), 'utf8');
  const instance = readFileSync(require.resolve('next/dist/client/components/app-router-instance.js'), 'utf8');

  it('patches pushState and replaceState to dispatch ACTION_RESTORE with the pushed url', () => {
    expect(src).toMatch(/window\.history\.pushState = function pushState\(data, _unused, url\)/);
    expect(src).toMatch(/window\.history\.replaceState = function replaceState\(data, _unused, url\)/);
    const apply = src.slice(src.indexOf('const applyUrlFromHistoryPushReplace'), src.indexOf('window.history.pushState = function'));
    expect(apply).toContain('ACTION_RESTORE');
    expect(apply).toMatch(/url: new URL\(url \?\? href, href\)/);
  });

  it('useSearchParams reads the router canonical URL', () => {
    expect(src).toMatch(/const url = new URL\(canonicalUrl,[^)]*\);\s*return \{[\s\S]{0,120}searchParams: url\.searchParams/);
    expect(src).toMatch(/SearchParamsContext\.Provider, \{\s*value: searchParams/);
  });

  it('Back/Forward (popstate) restores the same way — a traverse is ACTION_RESTORE', () => {
    expect(src).toContain('dispatchTraverseAction');
    const traverse = instance.slice(instance.indexOf('function dispatchTraverseAction'));
    expect(traverse.slice(0, 600)).toContain('ACTION_RESTORE');
  });

  it('a write carrying Next’s own `__NA` state skips the sync — callers must not pass history.state through', () => {
    // The loop guard: `if (data?.__NA || data?._N) return originalPushState(...)`.
    // Passing `window.history.state` (which holds __NA) therefore changes the
    // address bar but NOT useSearchParams, and the next router commit rewrites
    // the URL back. task-sheet-history.ts strips these keys for that reason.
    expect(src).toMatch(/if \(data\?\.__NA \|\| data\?\._N\) \{\s*return originalPushState/);
    expect(src).toMatch(/if \(data\?\.__NA \|\| data\?\._N\) \{\s*return originalReplaceState/);
  });
});

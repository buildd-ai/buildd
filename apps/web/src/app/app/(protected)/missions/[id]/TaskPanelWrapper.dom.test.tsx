/**
 * TaskPanelWrapper, mounted (happy-dom): the wiring between the delegated row
 * handler, native history, the URL-follow effect and the focus store — the
 * parts the pure history model and the static render cannot see.
 *
 * - a row tap pushes `?task=` and renders the sheet (AC-7);
 * - the pulse's second tap reaches the sheet owner through `store.setOpenTask`;
 * - a popstate that drops `task` closes the sheet (AC-8);
 * - closing lands focus on the row: `store.focus(prev, {writeHash:false})` and
 *   DOM focus back on the row (W5).
 *
 * `TaskSheet` is stubbed: its own shell and body are covered by
 * TaskSheet.test.tsx and TaskSheet.dom.test.tsx. This file runs in its own
 * process (scripts/run-unit-tests.ts), so the globals and module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// next/navigation: useSearchParams follows window.location, re-read when the
// test says the App Router synced (it does so for native pushState/replaceState
// and popstate — TaskSheet.next-history.test.ts proves that against real Next).
const urlListeners = new Set<() => void>();
const syncUrl = () => urlListeners.forEach(l => l());
const routerCalls: string[] = [];
const { useSyncExternalStore } = await import('react');
mock.module('next/navigation', () => ({
  useSearchParams: () => {
    const search = useSyncExternalStore(
      l => { urlListeners.add(l); return () => urlListeners.delete(l); },
      () => window.location.search,
      () => window.location.search,
    );
    return new URLSearchParams(search);
  },
  usePathname: () => window.location.pathname,
  useRouter: () => ({
    push: () => routerCalls.push('push'),
    replace: () => routerCalls.push('replace'),
    refresh: () => routerCalls.push('refresh'),
    back: () => routerCalls.push('back'),
    prefetch: () => {},
  }),
}));

// The sheet is a stub that exposes its task and its close.
mock.module('./TaskSheet', () => ({
  default: ({ taskId, onClose }: { taskId: string; onClose: () => void }) => (
    <div data-testid="mission-task-sheet" data-sheet-task={taskId}>
      <button type="button" data-testid="stub-close" onClick={onClose}>close</button>
    </div>
  ),
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MissionFocusContext } = await import('@/components/missions/mission-focus-context');
type Store = import('@/components/missions/mission-focus-context').MissionFocusStore;
const { default: TaskPanelWrapper } = await import('./TaskPanelWrapper');

// Illustrative fixtures only.
const A = '0a1b2c3d-1111-4222-8333-444455556666';
const B = '0a1b2c3d-2222-4222-8333-444455556666';

function fakeStore() {
  const calls = {
    setOpenTask: [] as Array<((id: string) => void) | null>,
    focus: [] as Array<[string, unknown]>,
    setSheetOpen: [] as boolean[],
  };
  const snap = { selectedTaskId: null, outlinedTaskId: null, inViewTaskIds: new Set<string>(), revealedTaskIds: new Set<string>(), frozen: false };
  const store = {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    selectSegment: () => {},
    focus: (id: string, opts?: unknown) => { calls.focus.push([id, opts]); },
    openTask: () => {},
    setOpenTask: (fn: ((id: string) => void) | null) => { calls.setOpenTask.push(fn); },
    readHash: () => {},
    registerRow: () => {},
    unregisterRow: () => {},
    setInView: () => {},
    notePointerDown: () => {},
    setSheetOpen: (open: boolean) => { calls.setSheetOpen.push(open); },
    createFreezeGate: <T,>() => (latest: T) => latest,
  } as unknown as Store;
  return { store, calls };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let pushes: string[];
let replaces: string[];
let backs: number;
const realPush = window.history.pushState.bind(window.history);
const realReplace = window.history.replaceState.bind(window.history);

beforeEach(() => {
  realReplace(null, '', '/app/missions/m1');
  pushes = [];
  replaces = [];
  backs = 0;
  routerCalls.length = 0;
  window.history.pushState = (d: unknown, u: string, url?: string | URL | null) => {
    pushes.push(String(url));
    realPush(d, u, url);
  };
  window.history.replaceState = (d: unknown, u: string, url?: string | URL | null) => {
    replaces.push(String(url));
    realReplace(d, u, url);
  };
  window.history.back = () => { backs += 1; };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(store: Store | null) {
  const list = (
    <ul>
      <li data-testid="mission-task-row" data-task-id={A}>
        <a href={`/app/missions/m1?task=${A}`} data-testid="row-a-link">Task A</a>
      </li>
      <li data-testid="mission-task-row" data-task-id={B}>
        <a href={`/app/missions/m1?task=${B}`} data-testid="row-b-link">Task B</a>
      </li>
    </ul>
  );
  const tree = createElement(TaskPanelWrapper, { missionId: 'm1', children: list });
  act(() => {
    root.render(store ? <MissionFocusContext.Provider value={store}>{tree}</MissionFocusContext.Provider> : tree);
  });
}

const sheet = () => container.querySelector('[data-testid="mission-task-sheet"]');
const click = (el: Element) => act(() => {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
});

describe('TaskPanelWrapper mounted — a row tap opens the sheet', () => {
  it('a click on a data-task-id row pushes ?task= and renders the sheet, without the router', () => {
    const { store } = fakeStore();
    mount(store);
    expect(sheet()).toBeNull();

    click(container.querySelector('[data-testid="row-a-link"]')!);

    expect(pushes).toHaveLength(1);
    expect(new URL(pushes[0], 'http://localhost').searchParams.get('task')).toBe(A);
    expect(sheet()?.getAttribute('data-sheet-task')).toBe(A);
    expect(routerCalls).toEqual([]);
  });

  it('the row link is not followed (capture phase prevents its default)', () => {
    const { store } = fakeStore();
    mount(store);
    const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }) as unknown as Event;
    act(() => { container.querySelector('[data-testid="row-a-link"]')!.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('TaskPanelWrapper mounted — the focus store routes opens here', () => {
  it('registers an opener with store.setOpenTask; calling it opens the sheet via pushState', () => {
    const { store, calls } = fakeStore();
    mount(store);
    const opener = calls.setOpenTask.find((f): f is (id: string) => void => typeof f === 'function');
    expect(opener).toBeDefined();

    act(() => opener!(B));

    expect(sheet()?.getAttribute('data-sheet-task')).toBe(B);
    expect(pushes).toHaveLength(1);
    expect(new URL(pushes[0], 'http://localhost').searchParams.get('task')).toBe(B);
  });

  it('tells the store the sheet is open, and closed again', () => {
    const { store, calls } = fakeStore();
    mount(store);
    click(container.querySelector('[data-testid="row-a-link"]')!);
    expect(calls.setSheetOpen.at(-1)).toBe(true);
    click(container.querySelector('[data-testid="stub-close"]')!);
    expect(calls.setSheetOpen.at(-1)).toBe(false);
  });
});

describe('TaskPanelWrapper mounted — the sheet follows the URL (AC-8)', () => {
  it('a popstate with no task param closes the sheet', () => {
    const { store } = fakeStore();
    mount(store);
    click(container.querySelector('[data-testid="row-a-link"]')!);
    expect(sheet()).not.toBeNull();

    // System Back: the browser restores the closed entry and fires popstate;
    // the App Router syncs useSearchParams from it.
    act(() => {
      realReplace(null, '', '/app/missions/m1');
      window.dispatchEvent(new window.PopStateEvent('popstate', { state: null }) as unknown as Event);
      syncUrl();
    });

    expect(sheet()).toBeNull();
  });

  it('a URL that gains ?task= (Forward) opens the sheet on that task', () => {
    const { store } = fakeStore();
    mount(store);
    act(() => {
      realReplace(null, '', `/app/missions/m1?task=${B}`);
      window.dispatchEvent(new window.PopStateEvent('popstate', { state: null }) as unknown as Event);
      syncUrl();
    });
    expect(sheet()?.getAttribute('data-sheet-task')).toBe(B);
  });
});

describe('TaskPanelWrapper mounted — closing lands on the row (W5)', () => {
  it('close after a push goes Back, and focuses the row in the store without writing the hash', () => {
    const { store, calls } = fakeStore();
    mount(store);
    click(container.querySelector('[data-testid="row-a-link"]')!);
    calls.focus.length = 0;

    click(container.querySelector('[data-testid="stub-close"]')!);

    expect(backs).toBe(1);
    expect(sheet()).toBeNull();
    expect(calls.focus).toHaveLength(1);
    expect(calls.focus[0][0]).toBe(A);
    expect(calls.focus[0][1]).toMatchObject({ writeHash: false });
  });

  it('entered with ?task=, close replaces to a URL without task and with #t-<id>', () => {
    realReplace(null, '', `/app/missions/m1?from=home&task=${A}`);
    const { store } = fakeStore();
    mount(store);
    expect(sheet()).not.toBeNull();

    click(container.querySelector('[data-testid="stub-close"]')!);

    expect(backs).toBe(0);
    expect(replaces.at(-1)).toBe(`/app/missions/m1?from=home#t-${A}`);
    expect(sheet()).toBeNull();
  });

  it('returns DOM focus to the row the sheet was opened on', () => {
    const { store } = fakeStore();
    mount(store);
    click(container.querySelector('[data-testid="row-b-link"]')!);
    (container.querySelector('[data-testid="stub-close"]') as HTMLElement).focus();

    click(container.querySelector('[data-testid="stub-close"]')!);

    expect(document.activeElement).toBe(container.querySelector('[data-testid="row-b-link"]'));
  });
});

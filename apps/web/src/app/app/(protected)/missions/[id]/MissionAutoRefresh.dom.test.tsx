/**
 * MissionAutoRefresh, mounted (happy-dom) with a mocked Pusher
 * (docs/design/mission-feed-mobile-continuity.md, slice S7):
 *
 * - AC-17: 20 `worker:progress` heartbeats → 0 `router.refresh` calls and 20
 *   live-store patches seen by a child; 5 structural events inside 3s → exactly
 *   1 refresh.
 * - Freeze rule: across a refresh that inserts a task above the viewport, the
 *   row the reader was looking at stays where it was on screen (`scrollTop`
 *   is corrected by exactly the inserted height), and the `N new ↑` pill
 *   appears instead.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Clock } from '@/lib/realtime-throttle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Mocks ──
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

type Handler = (data: unknown) => void;
const channels = new Map<string, Map<string, Handler[]>>();
function emit(channel: string, event: string, data: unknown) {
  for (const fn of channels.get(channel)?.get(event) ?? []) fn(data);
}
mock.module('@/lib/pusher-client', () => ({
  CHANNEL_PREFIX: '',
  subscribeToChannel: (name: string) => {
    const handlers = channels.get(name) ?? new Map<string, Handler[]>();
    channels.set(name, handlers);
    return {
      bind: (e: string, fn: Handler) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
      unbind: (e: string, fn: Handler) => handlers.set(e, (handlers.get(e) ?? []).filter(f => f !== fn)),
    };
  },
  unsubscribeFromChannel: () => {},
  getSubscribedChannel: () => null,
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionAutoRefresh } = await import('./MissionAutoRefresh');
const { useMissionLiveSnapshot, MISSION_REFRESH_WINDOW_MS } = await import('./MissionLiveStore');

function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id as number); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e;
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        act(() => due![1].fn());
      }
      t = end;
    },
  };
}

// ── Layout stub: rows stack at ROW_H inside a 700px scroller at y=0 ──
const ROW_H = 52;
let main: HTMLElement;
let scrollTop = 0;
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 390, width: 390, height, x: 0, y: top, toJSON() {} });
const origRect = HTMLElement.prototype.getBoundingClientRect;
const origRects = HTMLElement.prototype.getClientRects;

// Illustrative fixtures only.
const WS = 'ws-a';
const M = 'm1';
const ids = (n: number, prefix = 't') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let clock: ReturnType<typeof fakeClock>;
let snapshots = 0;

const MASTHEAD_H = 84;

function Rows({ taskIds, masthead }: { taskIds: string[]; masthead?: boolean }) {
  useMissionLiveSnapshot();
  snapshots++;
  const rows = taskIds.map(id =>
    createElement('a', { key: id, id: `t-${id}`, 'data-testid': 'mission-task-row', 'data-task-id': id }, id));
  if (!masthead) return createElement('div', null, rows);
  // The sticky masthead's pulse carries a `data-task-id` segment per task
  // (MissionPulse), always at or above the masthead's bottom edge.
  const pulse = createElement('div', { 'data-testid': 'mission-masthead', key: 'masthead' },
    taskIds.map(id => createElement('span', { key: id, 'data-testid': 'mission-pulse-segment', 'data-task-id': id })));
  return createElement('div', null, pulse, createElement('div', { key: 'list' }, rows));
}

let withMasthead = false;
function render(taskIds: string[], renderedAt: number) {
  act(() => root.render(
    createElement(MissionAutoRefresh, {
      missionId: M, workspaceId: WS, taskIds, renderedAt, clock,
      workerStatuses: { w1: 'running' },
      scroller: () => main,
    }, createElement(Rows, { taskIds, masthead: withMasthead })),
  ));
}

beforeEach(() => {
  routerCalls.length = 0;
  withMasthead = false;
  channels.clear();
  snapshots = 0;
  scrollTop = 0;
  clock = fakeClock();
  main = document.createElement('main');
  Object.defineProperty(main, 'scrollTop', { get: () => scrollTop, set: (v: number) => { scrollTop = v; }, configurable: true });
  document.body.appendChild(main);
  container = document.createElement('div');
  main.appendChild(container);
  root = createRoot(container);
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this === main) return rect(0, 700) as DOMRect;
    if (this.dataset?.testid === 'mission-masthead') return rect(0, MASTHEAD_H) as DOMRect;
    if (this.dataset?.testid === 'mission-pulse-segment') return rect(40, 8) as DOMRect;
    if (this.dataset?.taskId) {
      const rows = Array.from(main.querySelectorAll('[data-testid="mission-task-row"]'));
      const offset = withMasthead ? MASTHEAD_H : 0;
      return rect(offset + rows.indexOf(this) * ROW_H - scrollTop, ROW_H) as DOMRect;
    }
    return rect(0, 0) as DOMRect;
  };
  HTMLElement.prototype.getClientRects = function (this: HTMLElement) {
    return (this.dataset?.taskId ? [rect(0, ROW_H)] : []) as unknown as DOMRectList;
  };
});

afterEach(() => {
  act(() => root.unmount());
  main.remove();
  HTMLElement.prototype.getBoundingClientRect = origRect;
  HTMLElement.prototype.getClientRects = origRects;
});

const workspace = `workspace-${WS}`;

describe('AC-17 with a mocked Pusher', () => {
  it('20 worker:progress heartbeats → 0 refreshes, 20 store patches reach the children', () => {
    render(ids(3), 1);
    const before = snapshots;
    for (let i = 0; i < 20; i++) {
      act(() => emit(workspace, 'worker:progress', { workerId: 'w1', taskId: 't0', status: 'running', currentAction: `step ${i}` }));
      clock.advance(1_000);
    }
    clock.advance(10_000);
    expect(routerCalls.filter(c => c === 'refresh')).toHaveLength(0);
    expect(snapshots - before).toBe(20);
  });

  it('5 structural events within 3s → exactly 1 refresh', () => {
    render(ids(3), 1);
    act(() => emit(workspace, 'task:created', { task: { missionId: M } }));
    clock.advance(400);
    act(() => emit(workspace, 'task:claimed', { task: { id: 't1' } }));
    clock.advance(400);
    act(() => emit(workspace, 'worker:failed', { workerId: 'w1', taskId: 't1' }));
    clock.advance(400);
    act(() => emit(`mission-${M}`, 'mission:note_posted', {}));
    clock.advance(400);
    act(() => emit(`mission-${M}`, 'mission:completion_decision', { allowed: false }));
    clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(routerCalls).toEqual(['refresh']);
  });

  it('a new record (worker:artifact) on a mission task refreshes once', () => {
    render(ids(3), 1);
    act(() => emit(workspace, 'worker:artifact', { workerId: 'w1', taskId: 't1' }));
    clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(routerCalls).toEqual(['refresh']);
  });

  it('never calls router.push or router.replace', () => {
    render(ids(3), 1);
    act(() => emit(workspace, 'worker:progress', { taskId: 't2' }));
    clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(routerCalls).toEqual(['refresh']);
  });
});

describe('scroll anchor and the new-rows pill', () => {
  it('an insertion above the viewport keeps the reader’s row in place and shows `1 new ↑`', () => {
    const initial = ids(10);
    render(initial, 1);
    // The reader has scrolled so t5 sits at the top of the viewport.
    scrollTop = 5 * ROW_H;
    const anchorRow = () => main.querySelector('[data-task-id="t5"]')!;
    expect(anchorRow().getBoundingClientRect().top).toBe(0);

    act(() => emit(workspace, 'task:created', { task: { missionId: M } }));
    clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(routerCalls).toEqual(['refresh']);

    // The new render commits with a task above everything on screen.
    render(['new0', ...initial], 2);

    expect(anchorRow().getBoundingClientRect().top).toBe(0);
    expect(scrollTop).toBe(6 * ROW_H);
    const pill = main.ownerDocument.querySelector('[data-testid="mission-new-rows-pill"]');
    expect(pill?.textContent).toBe('1 new ↑');
    expect(pill?.getAttribute('aria-label')).toBe('1 new task above');
  });

  it('an insertion below the viewport moves nothing and shows no pill', () => {
    const initial = ids(30);
    render(initial, 1);
    act(() => emit(workspace, 'task:created', { task: { missionId: M } }));
    clock.advance(MISSION_REFRESH_WINDOW_MS);
    render([...initial, 'new0'], 2);
    expect(scrollTop).toBe(0);
    expect(document.querySelector('[data-testid="mission-new-rows-pill"]')).toBeNull();
  });

  it('a pulse segment in the sticky masthead does not count as a row above the viewport', () => {
    // Regression: the pulse segment for a new task sits inside the masthead,
    // so its bottom is always at or above the visible top. Only list rows count.
    withMasthead = true;
    const initial = ids(5);
    render(initial, 1);
    act(() => emit(workspace, 'task:created', { task: { missionId: M } }));
    clock.advance(MISSION_REFRESH_WINDOW_MS);
    // new0's real row lands on screen, below the masthead.
    render([...initial, 'new0'], 2);
    expect(scrollTop).toBe(0);
    expect(document.querySelector('[data-testid="mission-new-rows-pill"]')).toBeNull();
  });

  it('with a masthead, an insertion above the viewport still shows the pill and anchors a list row', () => {
    withMasthead = true;
    const initial = ids(10);
    render(initial, 1);
    scrollTop = 5 * ROW_H;
    act(() => emit(workspace, 'task:created', { task: { missionId: M } }));
    clock.advance(MISSION_REFRESH_WINDOW_MS);
    render(['new0', ...initial], 2);
    expect(scrollTop).toBe(6 * ROW_H);
    expect(document.querySelector('[data-testid="mission-new-rows-pill"]')).not.toBeNull();
  });

  it('the pill names its count for screen readers and hides the arrow', () => {
    const initial = ids(10);
    render(initial, 1);
    scrollTop = 5 * ROW_H;
    act(() => emit(workspace, 'task:created', { task: { missionId: M } }));
    clock.advance(MISSION_REFRESH_WINDOW_MS);
    render(['new0', 'new1', ...initial], 2);
    const pill = document.querySelector('[data-testid="mission-new-rows-pill"]') as HTMLElement;
    expect(pill.getAttribute('aria-label')).toBe('2 new tasks above');
    expect(pill.querySelector('[aria-hidden="true"]')?.textContent).toBe('↑');
    // Its arrival is announced politely.
    expect(document.querySelector('[data-testid="mission-new-rows-status"]')?.textContent).toBe('2 new tasks above');
  });

  it('tapping the pill clears it', () => {
    const initial = ids(10);
    render(initial, 1);
    scrollTop = 5 * ROW_H;
    act(() => emit(workspace, 'task:created', { task: { missionId: M } }));
    clock.advance(MISSION_REFRESH_WINDOW_MS);
    render(['new0', ...initial], 2);
    const pill = document.querySelector('[data-testid="mission-new-rows-pill"]') as HTMLElement;
    act(() => { pill.click(); });
    expect(document.querySelector('[data-testid="mission-new-rows-pill"]')).toBeNull();
  });
});

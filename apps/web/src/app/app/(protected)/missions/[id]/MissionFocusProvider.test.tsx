/**
 * MissionFocusProvider: one selection shared by the pulse and the list, the
 * `#t-` hash, unfold-then-scroll, and the freeze window
 * (docs/design/mission-feed-mobile-continuity.md, W3 "Pulse interaction" and
 * "Freeze rule"). AC-6 lives here.
 *
 * The store is driven through injected history/location/timers, so every
 * assertion uses a fake clock rather than real time.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FOCUS_OUTLINE_MS,
  FREEZE_AFTER_POINTER_MS,
  MissionFocusProvider,
  createMissionFocusStore,
  type MissionFocusDeps,
} from './MissionFocusProvider';
import MissionPulse from '@/components/missions/MissionPulse';
import MissionTaskRow from '@/components/missions/MissionTaskRow';
import { buildMissionFeedGroups } from '@/lib/mission-feed-groups';
import { buildPulseSegments, type MissionFeedTaskInput } from '@/lib/mission-pulse';

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = target;
    },
  };
}

function setup(initial: { search?: string; hash?: string } = {}) {
  const clock = fakeClock();
  const loc = { pathname: '/app/missions/m1', search: initial.search ?? '?from=home', hash: initial.hash ?? '' };
  const replaced: string[] = [];
  const pushed: string[] = [];
  const scrolled: Array<{ id: string; block: string }> = [];
  const apply = (url: string) => {
    const u = new URL(url, 'https://example.invalid');
    loc.search = u.search;
    loc.hash = u.hash;
  };
  const deps: MissionFocusDeps = {
    history: {
      state: { keep: true },
      replaceState: (_s, _t, url) => { replaced.push(String(url)); apply(String(url)); },
      pushState: (_s, _t, url) => { pushed.push(String(url)); apply(String(url)); },
    },
    location: () => ({ ...loc }),
    scrollIntoView: (el, block) => scrolled.push({ id: (el as unknown as { id: string }).id, block }),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  const store = createMissionFocusStore(deps);
  const el = (taskId: string) => ({ id: `t-${taskId}` }) as unknown as HTMLElement;
  return { store, clock, loc, replaced, pushed, scrolled, el };
}

describe('segment select → focus (AC-6)', () => {
  it('first select writes #t-<id> with replaceState, keeps the query, and outlines the row', () => {
    const { store, replaced, pushed, el } = setup();
    store.registerRow('b', el('b'));
    store.selectSegment('b');
    expect(replaced).toEqual(['/app/missions/m1?from=home#t-b']);
    expect(pushed).toEqual([]);
    expect(store.getSnapshot().selectedTaskId).toBe('b');
    expect(store.getSnapshot().outlinedTaskId).toBe('b');
  });

  it('scrolls the row to the top of the scroller (under the sticky masthead)', () => {
    const { store, scrolled, el } = setup();
    store.registerRow('b', el('b'));
    store.selectSegment('b');
    expect(scrolled).toEqual([{ id: 't-b', block: 'start' }]);
  });

  it('a second select on the same segment opens the sheet with pushState(?task=)', () => {
    const { store, replaced, pushed, el } = setup();
    store.registerRow('b', el('b'));
    store.selectSegment('b');
    store.selectSegment('b');
    expect(replaced).toHaveLength(1);
    expect(pushed).toEqual(['/app/missions/m1?from=home&task=b']);
  });

  it('a select on a different segment moves focus instead of opening', () => {
    const { store, pushed, el } = setup();
    store.registerRow('a', el('a'));
    store.registerRow('b', el('b'));
    store.selectSegment('a');
    store.selectSegment('b');
    expect(pushed).toEqual([]);
    expect(store.getSnapshot().selectedTaskId).toBe('b');
  });

  it('delegates opening to onOpenTask when the sheet owner supplies one', () => {
    const { store, pushed, el } = setup();
    const opened: string[] = [];
    store.setOpenTask(id => opened.push(id));
    store.registerRow('b', el('b'));
    store.selectSegment('b');
    store.selectSegment('b');
    expect(opened).toEqual(['b']);
    expect(pushed).toEqual([]);
  });

  it('the outline fades after 2s; the selection (aria-current) stays', () => {
    const { store, clock, el } = setup();
    store.registerRow('b', el('b'));
    store.selectSegment('b');
    clock.advance(FOCUS_OUTLINE_MS - 1);
    expect(store.getSnapshot().outlinedTaskId).toBe('b');
    clock.advance(1);
    expect(store.getSnapshot().outlinedTaskId).toBeNull();
    expect(store.getSnapshot().selectedTaskId).toBe('b');
    expect(FOCUS_OUTLINE_MS).toBe(2000);
  });
});

describe('unfold-then-scroll', () => {
  it('reveals a row that is not mounted and scrolls once it registers', () => {
    const { store, scrolled, el } = setup();
    store.selectSegment('z');
    expect(store.getSnapshot().revealedTaskIds.has('z')).toBe(true);
    expect(scrolled).toEqual([]);
    store.registerRow('z', el('z'));
    expect(scrolled).toEqual([{ id: 't-z', block: 'start' }]);
    // Re-registering (a re-render) does not scroll again.
    store.registerRow('z', el('z'));
    expect(scrolled).toHaveLength(1);
  });

  it('unregistering a row clears it from in-view', () => {
    const { store, el } = setup();
    store.registerRow('a', el('a'));
    store.setInView('a', true);
    expect(store.getSnapshot().inViewTaskIds.has('a')).toBe(true);
    store.unregisterRow('a');
    expect(store.getSnapshot().inViewTaskIds.has('a')).toBe(false);
  });
});

describe('hash arrival', () => {
  it('reads #t-<id> on start: focuses and centres the row without writing history', () => {
    const { store, replaced, scrolled, el } = setup({ hash: '#t-c' });
    store.readHash();
    expect(store.getSnapshot().selectedTaskId).toBe('c');
    expect(replaced).toEqual([]);
    store.registerRow('c', el('c'));
    expect(scrolled).toEqual([{ id: 't-c', block: 'center' }]);
  });

  it('ignores a hash that is not a task anchor', () => {
    const { store } = setup({ hash: '#mission-artifacts' });
    store.readHash();
    expect(store.getSnapshot().selectedTaskId).toBeNull();
  });
});

describe('in-view set', () => {
  it('keeps a stable snapshot reference when nothing changed', () => {
    const { store, el } = setup();
    store.registerRow('a', el('a'));
    store.setInView('a', true);
    const snap = store.getSnapshot();
    store.setInView('a', true);
    expect(store.getSnapshot()).toBe(snap);
  });
});

describe('freeze window', () => {
  it('freezes for 1.5s after a pointerdown on the list, then notifies', () => {
    const { store, clock } = setup();
    let notified = 0;
    store.subscribe(() => notified++);
    store.notePointerDown();
    expect(store.getSnapshot().frozen).toBe(true);
    clock.advance(FREEZE_AFTER_POINTER_MS - 1);
    expect(store.getSnapshot().frozen).toBe(true);
    const before = notified;
    clock.advance(1);
    expect(store.getSnapshot().frozen).toBe(false);
    expect(notified).toBeGreaterThan(before);
    expect(FREEZE_AFTER_POINTER_MS).toBe(1500);
  });

  it('a second pointerdown extends the window', () => {
    const { store, clock } = setup();
    store.notePointerDown();
    clock.advance(1000);
    store.notePointerDown();
    clock.advance(1000);
    expect(store.getSnapshot().frozen).toBe(true);
    clock.advance(500);
    expect(store.getSnapshot().frozen).toBe(false);
  });

  it('stays frozen while the sheet is open, regardless of time', () => {
    const { store, clock } = setup();
    store.setSheetOpen(true);
    clock.advance(60_000);
    expect(store.getSnapshot().frozen).toBe(true);
    store.setSheetOpen(false);
    expect(store.getSnapshot().frozen).toBe(false);
  });

  it('sheet close inside a pointer window stays frozen until the window ends', () => {
    const { store, clock } = setup();
    store.setSheetOpen(true);
    store.notePointerDown();
    store.setSheetOpen(false);
    expect(store.getSnapshot().frozen).toBe(true);
    clock.advance(FREEZE_AFTER_POINTER_MS);
    expect(store.getSnapshot().frozen).toBe(false);
  });

  it('freezeValue holds the committed value while frozen and releases the latest after', () => {
    const { store, clock } = setup();
    const gate = store.createFreezeGate<string[]>();
    expect(gate(['a', 'b'])).toEqual(['a', 'b']);
    store.notePointerDown();
    expect(gate(['b', 'a'])).toEqual(['a', 'b']);
    clock.advance(FREEZE_AFTER_POINTER_MS);
    expect(gate(['b', 'a'])).toEqual(['b', 'a']);
  });
});

// ─── Connected render: pulse + row share the selection ───────────────────────

let c = Date.UTC(2026, 0, 1);
const task = (id: string, over: Partial<MissionFeedTaskInput> = {}): MissionFeedTaskInput => {
  c += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(c), ...over };
};

describe('MissionFocusProvider (connected render)', () => {
  it('a selected segment is aria-current in the pulse and the same row is data-focused (AC-6)', () => {
    const tasks = [task('a', { status: 'completed' }), task('b')];
    const model = buildMissionFeedGroups(tasks);
    const { store, el } = setup();
    store.registerRow('b', el('b'));
    store.selectSegment('b');
    const html = renderToStaticMarkup(
      <MissionFocusProvider missionId="m1" store={store}>
        <MissionPulse segments={buildPulseSegments(tasks)} variant="header" connected />
        {['a', 'b'].map(id => <MissionTaskRow key={id} row={model.rowsById.get(id)!} missionId="m1" now={0} />)}
      </MissionFocusProvider>,
    );
    expect(html).toMatch(/data-task-id="b"[^>]*aria-current="true"|aria-current="true"[^>]*data-task-id="b"/);
    const rowB = html.match(/<a[^>]*data-testid="mission-task-row"[^>]*data-task-id="b"[^>]*>/)?.[0] ?? '';
    const rowA = html.match(/<a[^>]*data-testid="mission-task-row"[^>]*data-task-id="a"[^>]*>/)?.[0] ?? '';
    expect(rowB).toContain('data-focused="true"');
    expect(rowA).toContain('data-focused="false"');
  });

  it('renders children without a store prop (server render is inert)', () => {
    const html = renderToStaticMarkup(
      <MissionFocusProvider missionId="m1"><span>child</span></MissionFocusProvider>,
    );
    expect(html).toContain('child');
  });
});

describe('history writes reach useSearchParams (S4 crux)', () => {
  // The App Router skips its useSearchParams sync for any write whose data
  // carries Next's own `__NA` marker (TaskSheet.next-history.test.ts). Passing
  // `history.state` straight through therefore opened nothing: the address bar
  // gained ?task= but the sheet owner never saw it.
  function nextState() {
    const datas: unknown[] = [];
    const deps: MissionFocusDeps = {
      history: {
        state: { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] }, keep: true },
        replaceState: d => { datas.push(d); },
        pushState: d => { datas.push(d); },
      },
      location: () => ({ pathname: '/app/missions/m1', search: '', hash: '' }),
      scrollIntoView: () => {},
      now: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => {},
    };
    return { store: createMissionFocusStore(deps), datas };
  }

  it('openTask pushes without Next’s internal markers, keeping the caller’s own keys', () => {
    const { store, datas } = nextState();
    store.openTask('b');
    expect(datas).toEqual([{ keep: true }]);
  });

  it('focus writes the hash without Next’s internal markers', () => {
    const { store, datas } = nextState();
    store.focus('b');
    expect(datas).toEqual([{ keep: true }]);
  });
});

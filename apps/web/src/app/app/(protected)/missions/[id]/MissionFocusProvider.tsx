'use client';

/**
 * The mission page's single selection (docs/design/mission-feed-mobile-continuity.md,
 * W3 "Pulse interaction", "Scroll", and the freeze rule).
 *
 * One store owns:
 * - the selection shared by the pulse and the list (`aria-current` / outline);
 * - the `#t-<id>` hash, read on arrival and written with `replaceState` on
 *   segment focus (a hash change triggers no server render);
 * - unfold-then-scroll: focusing a row that is folded away marks it revealed,
 *   and the scroll happens when the row mounts and registers;
 * - the IntersectionObserver feeding the pulse's in-view underline;
 * - the freeze window: while the sheet is open, or within 1.5s of a pointerdown
 *   on the list, list order is held (`createFreezeGate`).
 *
 * Opening a task is `pushState(?task=)` by default — never `router.push` — and
 * the sheet owner (slice S4) may take it over with `setOpenTask`, and reports
 * open/closed with `setSheetOpen`.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { MissionFocusContext, type MissionFocusSnapshot, type MissionFocusStore } from '@/components/missions/mission-focus-context';
import { MISSION_MASTHEAD_FOLDED_PX } from '@/components/missions/MissionMasthead';
import { missionTaskAnchorId, parseMissionTaskHash } from '@/lib/mission-task-href';

export type { MissionFocusSnapshot, MissionFocusStore };

/** How long the focus outline stays on a row. */
export const FOCUS_OUTLINE_MS = 2000;
/** Rows stay put this long after the last pointerdown on the list. */
export const FREEZE_AFTER_POINTER_MS = 1500;

type TimerId = ReturnType<typeof setTimeout> | number;

export interface MissionFocusDeps {
  history: {
    readonly state: unknown;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
  };
  location(): { pathname: string; search: string; hash: string };
  scrollIntoView(el: HTMLElement, block: ScrollLogicalPosition): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
  /** Build the in-view observer. Absent in tests and on the server. */
  createObserver?(onChange: (taskId: string, inView: boolean) => void): {
    observe(el: HTMLElement): void;
    unobserve(el: HTMLElement): void;
  } | null;
}

export function createMissionFocusStore(deps: MissionFocusDeps): MissionFocusStore {
  const listeners = new Set<() => void>();
  const rows = new Map<string, HTMLElement>();
  let selectedTaskId: string | null = null;
  let outlinedTaskId: string | null = null;
  let inViewTaskIds: ReadonlySet<string> = new Set();
  let revealedTaskIds: ReadonlySet<string> = new Set();
  let sheetOpen = false;
  let lastPointerDown = -Infinity;
  let outlineTimer: TimerId | null = null;
  let freezeTimer: TimerId | null = null;
  let pendingScroll: { taskId: string; block: ScrollLogicalPosition } | null = null;
  let openTaskFn: ((taskId: string) => void) | null = null;
  let observer: ReturnType<NonNullable<MissionFocusDeps['createObserver']>> | undefined;

  const isFrozenNow = () => sheetOpen || deps.now() - lastPointerDown < FREEZE_AFTER_POINTER_MS;

  let snapshot: MissionFocusSnapshot = build();
  function build(): MissionFocusSnapshot {
    return { selectedTaskId, outlinedTaskId, inViewTaskIds, revealedTaskIds, frozen: isFrozenNow() };
  }
  function emit() {
    snapshot = build();
    for (const l of [...listeners]) l();
  }

  function getObserver() {
    if (observer === undefined) observer = deps.createObserver?.((id, v) => store.setInView(id, v)) ?? null;
    return observer;
  }

  const store: MissionFocusStore = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    selectSegment(taskId) {
      if (selectedTaskId === taskId) store.openTask(taskId);
      else store.focus(taskId, { writeHash: true, block: 'start' });
    },

    focus(taskId, { writeHash = true, block = 'start' } = {}) {
      selectedTaskId = taskId;
      outlinedTaskId = taskId;
      if (outlineTimer !== null) deps.clearTimeout(outlineTimer);
      outlineTimer = deps.setTimeout(() => {
        outlineTimer = null;
        outlinedTaskId = null;
        emit();
      }, FOCUS_OUTLINE_MS);

      if (writeHash) {
        const loc = deps.location();
        deps.history.replaceState(
          deps.history.state,
          '',
          `${loc.pathname}${loc.search}#${missionTaskAnchorId(encodeURIComponent(taskId))}`,
        );
      }
      if (!revealedTaskIds.has(taskId)) revealedTaskIds = new Set([...revealedTaskIds, taskId]);

      const el = rows.get(taskId);
      if (el) {
        pendingScroll = null;
        deps.scrollIntoView(el, block);
      } else {
        pendingScroll = { taskId, block };
      }
      emit();
    },

    openTask(taskId) {
      if (openTaskFn) {
        openTaskFn(taskId);
        return;
      }
      const loc = deps.location();
      const params = new URLSearchParams(loc.search);
      params.set('task', taskId);
      deps.history.pushState(deps.history.state, '', `${loc.pathname}?${params.toString()}`);
    },

    setOpenTask(fn) {
      openTaskFn = fn;
    },

    readHash() {
      const id = parseMissionTaskHash(deps.location().hash);
      if (id) store.focus(id, { writeHash: false, block: 'center' });
    },

    registerRow(taskId, el) {
      const prev = rows.get(taskId);
      rows.set(taskId, el);
      const obs = getObserver();
      if (obs && prev !== el) {
        if (prev) obs.unobserve(prev);
        obs.observe(el);
      }
      if (pendingScroll?.taskId === taskId) {
        const { block } = pendingScroll;
        pendingScroll = null;
        deps.scrollIntoView(el, block);
      }
    },

    unregisterRow(taskId) {
      const el = rows.get(taskId);
      rows.delete(taskId);
      if (el) getObserver()?.unobserve(el);
      if (inViewTaskIds.has(taskId)) {
        const next = new Set(inViewTaskIds);
        next.delete(taskId);
        inViewTaskIds = next;
        emit();
      }
    },

    setInView(taskId, inView) {
      if (inViewTaskIds.has(taskId) === inView) return;
      const next = new Set(inViewTaskIds);
      if (inView) next.add(taskId);
      else next.delete(taskId);
      inViewTaskIds = next;
      emit();
    },

    notePointerDown() {
      const wasFrozen = snapshot.frozen;
      lastPointerDown = deps.now();
      if (freezeTimer !== null) deps.clearTimeout(freezeTimer);
      freezeTimer = deps.setTimeout(() => {
        freezeTimer = null;
        emit();
      }, FREEZE_AFTER_POINTER_MS);
      if (!wasFrozen) emit();
    },

    setSheetOpen(open) {
      if (sheetOpen === open) return;
      sheetOpen = open;
      emit();
    },

    createFreezeGate<T>() {
      let has = false;
      let committed: T;
      return (latest: T) => {
        if (!has || !isFrozenNow()) {
          committed = latest;
          has = true;
        }
        return committed;
      };
    },
  };
  return store;
}

/** Real browser wiring. Every call is lazy, so creating the store during SSR is inert. */
function browserDeps(): MissionFocusDeps {
  return {
    history: {
      get state() { return window.history.state; },
      replaceState: (d, u, url) => window.history.replaceState(d, u, url),
      pushState: (d, u, url) => window.history.pushState(d, u, url),
    },
    location: () => ({ pathname: window.location.pathname, search: window.location.search, hash: window.location.hash }),
    scrollIntoView(el, block) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block, behavior: reduce ? 'auto' : 'smooth' });
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: id => window.clearTimeout(id as number),
    createObserver(onChange) {
      if (typeof IntersectionObserver === 'undefined') return null;
      // The app shell scrolls inside <main>; the folded masthead covers its top.
      const io = new IntersectionObserver(
        entries => {
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.taskId;
            if (id) onChange(id, e.isIntersecting);
          }
        },
        { root: document.querySelector('main'), rootMargin: `-${MISSION_MASTHEAD_FOLDED_PX}px 0px 0px 0px` },
      );
      return { observe: el => io.observe(el), unobserve: el => io.unobserve(el) };
    },
  };
}

export interface MissionFocusProviderProps {
  missionId: string;
  children: ReactNode;
  /** Inject a store (tests). Defaults to one wired to the browser. */
  store?: MissionFocusStore;
}

export function MissionFocusProvider({ missionId, children, store: injected }: MissionFocusProviderProps) {
  // One store per mounted mission page. Navigating to another mission changes
  // the `[id]` segment, which remounts the page and so this provider.
  const [owned] = useState(() => injected ?? createMissionFocusStore(browserDeps()));
  const store = injected ?? owned;

  useEffect(() => {
    store.readHash();
    const onHash = () => store.readHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [store]);

  return (
    <MissionFocusContext.Provider value={store}>
      {/* `contents`: no box, but pointerdown anywhere in the mission still opens the freeze window. */}
      <div className="contents" data-mission-id={missionId} onPointerDownCapture={() => store.notePointerDown()}>
        {children}
      </div>
    </MissionFocusContext.Provider>
  );
}

export default MissionFocusProvider;

'use client';

/**
 * The React context the mission-feed components read their shared selection
 * from. The store itself (and the provider that owns it) lives beside the
 * mission page in `missions/[id]/MissionFocusProvider.tsx`; this module only
 * holds the contract so `components/missions/*` can read it without importing
 * a route file.
 *
 * Every hook here returns null outside a provider, so the same component
 * renders on a card (no provider, no interaction) and on the detail page.
 */
import { createContext, useContext, useSyncExternalStore } from 'react';

export interface MissionFocusSnapshot {
  /** The one selection shared by pulse and list (`aria-current`). */
  selectedTaskId: string | null;
  /** The row currently outlined; clears after the outline fade. */
  outlinedTaskId: string | null;
  /** Rows whose element intersects the scroller (pulse underline). */
  inViewTaskIds: ReadonlySet<string>;
  /** Rows the list must unfold (collapsed phase, `+N`) so focus can land. */
  revealedTaskIds: ReadonlySet<string>;
  /** Group and row order must not change while true (sheet open, or just touched). */
  frozen: boolean;
}

export interface MissionFocusStore {
  getSnapshot(): MissionFocusSnapshot;
  subscribe(listener: () => void): () => void;
  /** Pulse segment tap / scrub release: focus, or open when already focused. */
  selectSegment(taskId: string): void;
  /** Focus a row without opening it. `writeHash` false for hash arrivals. */
  focus(taskId: string, opts?: { writeHash?: boolean; block?: ScrollLogicalPosition }): void;
  /** Open the task (sheet). Delegates to the sheet owner when one registered. */
  openTask(taskId: string): void;
  setOpenTask(fn: ((taskId: string) => void) | null): void;
  /** Read `#t-<id>` from the current location and focus it (no history write). */
  readHash(): void;
  registerRow(taskId: string, el: HTMLElement): void;
  unregisterRow(taskId: string): void;
  setInView(taskId: string, inView: boolean): void;
  notePointerDown(): void;
  setSheetOpen(open: boolean): void;
  /**
   * A gate for list data: returns the last value committed while unfrozen, so
   * realtime updates never move rows under a finger. Once the freeze ends the
   * latest value passes through (the list re-renders on the store notification).
   */
  createFreezeGate<T>(): (latest: T) => T;
}

export const MissionFocusContext = createContext<MissionFocusStore | null>(null);

const EMPTY: MissionFocusSnapshot = {
  selectedTaskId: null,
  outlinedTaskId: null,
  inViewTaskIds: new Set(),
  revealedTaskIds: new Set(),
  frozen: false,
};
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

/** The store, or null outside a provider. */
export function useMissionFocusStore(): MissionFocusStore | null {
  return useContext(MissionFocusContext);
}

/** The current focus snapshot, or null outside a provider. */
export function useMissionFocusSnapshot(): MissionFocusSnapshot | null {
  const store = useContext(MissionFocusContext);
  const snap = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : emptySnapshot,
    store ? store.getSnapshot : emptySnapshot,
  );
  return store ? snap : null;
}

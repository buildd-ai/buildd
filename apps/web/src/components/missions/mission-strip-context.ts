'use client';

/**
 * The mission page's Landed strip selection: which task the tethered drawer
 * shows. A tiny external store, so a selection change re-renders only the
 * strip and its drawer — never the board around them — and so the situation
 * block above can hand its task to the drawer instead of drawing a second,
 * detached call to action.
 */
import { createContext, useContext } from 'react';

export interface MissionStripStore {
  subscribe(listener: () => void): () => void;
  /** The chosen task, or null for the default (the strip derives it). */
  getSelected(): string | null;
  /** Bumped by `select(..., { focus: true })`: the drawer scrolls into view and takes focus. */
  getFocusNonce(): number;
  select(taskId: string, opts?: { focus?: boolean }): void;
}

export function createMissionStripStore(): MissionStripStore {
  const listeners = new Set<() => void>();
  let selected: string | null = null;
  let focusNonce = 0;
  const emit = () => { for (const l of listeners) l(); };
  return {
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
    getSelected: () => selected,
    getFocusNonce: () => focusNonce,
    select(taskId, opts) {
      if (selected === taskId && !opts?.focus) return;
      selected = taskId;
      if (opts?.focus) focusNonce += 1;
      emit();
    },
  };
}

export interface MissionStripValue {
  store: MissionStripStore;
  /** The tasks the strip draws, in strip order. */
  taskIds: readonly string[];
}

export const MissionStripContext = createContext<MissionStripValue | null>(null);

/** The strip on this page, when there is one (the Board layout). */
export function useMissionStrip(): MissionStripValue | null {
  return useContext(MissionStripContext);
}

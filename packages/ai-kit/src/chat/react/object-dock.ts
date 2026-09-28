/**
 * The object dock, as pure models: the docked pane's state (which side the
 * object sits on, whether it's closed, what's pinned) and which one thing a
 * side panel shows. Generic over the app's `ObjectRef` kinds; the app renders
 * each kind and decides where "Pop out" goes.
 */
import type { ObjectRef } from '@builddai/ai-kit/chat/contract';

// ── Pane ──────────────────────────────────────────────────────────────────────

export type PaneSide = 'left' | 'right';

export interface PaneState<R extends ObjectRef = ObjectRef> {
  /** Where the object goes. Default left: wide objects (boards, lanes) read left to right. */
  side: PaneSide;
  closed: boolean;
  pinned: R | null;
}

export type PaneAction<R extends ObjectRef = ObjectRef> =
  | { type: 'open'; ref: R }
  | { type: 'close' }
  | { type: 'swap' }
  | { type: 'unpin' }
  | { type: 'side'; side: PaneSide };

export const INITIAL_PANE: PaneState<never> = { side: 'left', closed: false, pinned: null };

/** Default storage key for the remembered side (the app may use its own). */
export const PANE_SIDE_KEY = 'kit-chat-pane-side';

export function paneReducer<R extends ObjectRef>(state: PaneState<R>, action: PaneAction<R>): PaneState<R> {
  switch (action.type) {
    case 'open':
      return { ...state, closed: false, pinned: action.ref };
    case 'close':
      return { ...state, closed: true, pinned: null };
    case 'swap':
      return { ...state, side: state.side === 'left' ? 'right' : 'left' };
    case 'unpin':
      return { ...state, pinned: null };
    case 'side':
      return { ...state, side: action.side };
  }
}

/** A stored side: anything but `'right'` reads as the default, left. */
export function parsePaneSide(v: string | null | undefined): PaneSide {
  return v === 'right' ? 'right' : 'left';
}

// ── Dock choice ───────────────────────────────────────────────────────────────

/**
 * What a side panel shows: the conversation history, the object the chat is
 * about, or the object that needs the person.
 */
export type DockMode = 'history' | 'object' | 'needs';
export interface DockChoice<R extends ObjectRef = ObjectRef> { mode: DockMode; ref: R | null }

/**
 * History when it was asked for, else the object the chat is about, else the
 * object that needs the person (unless they closed it this session, by id).
 * Null: no panel.
 */
export function dockChoice<R extends ObjectRef>(input: {
  historyOpen: boolean;
  focus: R | null;
  needsRef: R | null;
  needsClosedId: string | null;
}): DockChoice<R> | null {
  if (input.historyOpen) return { mode: 'history', ref: null };
  if (input.focus) return { mode: 'object', ref: input.focus };
  if (input.needsRef && input.needsRef.id !== input.needsClosedId) return { mode: 'needs', ref: input.needsRef };
  return null;
}

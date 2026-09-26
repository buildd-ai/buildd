/**
 * The docked pane's state: which side the object sits on (saved per user,
 * in this browser), whether it's closed, and what's pinned. Pure reducer plus
 * the href a pop-out opens.
 */
import type { BuilddObjectRef } from './chat-contract';
import { taskPageHref } from '@/lib/mission-task-href';

export type PaneSide = 'left' | 'right';

export interface PaneState {
  /** Where the object goes. Default left: Board and Lanes read left to right, so they get the wide side. */
  side: PaneSide;
  closed: boolean;
  pinned: BuilddObjectRef | null;
}

export type PaneAction =
  | { type: 'open'; ref: BuilddObjectRef }
  | { type: 'close' }
  | { type: 'swap' }
  | { type: 'unpin' }
  | { type: 'side'; side: PaneSide };

export const INITIAL_PANE: PaneState = { side: 'left', closed: false, pinned: null };
export const PANE_SIDE_KEY = 'buildd-chat-pane-side';

export function paneReducer(state: PaneState, action: PaneAction): PaneState {
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

export function parsePaneSide(v: string | null | undefined): PaneSide {
  return v === 'right' ? 'right' : 'left';
}

/** The object's own full page, for Pop out. */
export function popOutHref(ref: BuilddObjectRef, extra?: { missionId?: string | null; prUrl?: string | null }): string | null {
  switch (ref.kind) {
    case 'mission':
      return `/app/missions/${ref.id}`;
    case 'task':
      return taskPageHref({ taskId: ref.id, missionId: extra?.missionId ?? null });
    case 'question':
      return `/app/tasks/${ref.taskId}/respond`;
    case 'pr':
      return extra?.prUrl ?? ref.url ?? null;
    default:
      return null;
  }
}

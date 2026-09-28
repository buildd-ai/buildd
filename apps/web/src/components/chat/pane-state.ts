/**
 * The docked pane's state: which side the object sits on (saved per user,
 * in this browser), whether it's closed, and what's pinned. The reducer is the
 * kit's (`paneReducer` / `parsePaneSide` from @builddai/ai-kit/chat/react) over
 * buildd's refs; buildd keeps its storage key and where Pop out goes.
 */
import {
  INITIAL_PANE as KIT_INITIAL_PANE,
  paneReducer as kitPaneReducer,
  parsePaneSide,
  type PaneAction as KitPaneAction,
  type PaneSide,
  type PaneState as KitPaneState,
} from '@builddai/ai-kit/chat/react';
import type { BuilddObjectRef } from './chat-contract';
import { taskPageHref } from '@/lib/mission-task-href';

export { parsePaneSide, type PaneSide };
export type PaneState = KitPaneState<BuilddObjectRef>;
export type PaneAction = KitPaneAction<BuilddObjectRef>;

export const INITIAL_PANE: PaneState = KIT_INITIAL_PANE;
export const PANE_SIDE_KEY = 'buildd-chat-pane-side';

export function paneReducer(state: PaneState, action: PaneAction): PaneState {
  return kitPaneReducer(state, action);
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

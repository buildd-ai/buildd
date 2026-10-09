/**
 * How Activity groups and trims local interactive sessions. Pure and
 * client-safe (InteractiveSessions renders in the client bundle): types come
 * from lib/local-session-view.ts as type-only imports, never its db reads.
 */
import type { LocalSessionTaskView, LocalSessionView } from './local-session-view';

/** How many of a session's tasks Activity shows before "+N more". */
export const SESSION_TASK_PREVIEW = 3;

export interface SessionDisplayGroups {
  /** Holding at least one live task. */
  working: LocalSessionView[];
  /** Online, no live task: presence only. */
  idleOnline: LocalSessionView[];
  /** Offline or ended: history, folded by default. */
  earlier: LocalSessionView[];
}

/** Split already-sorted sessions into what Activity leads with and what it folds. */
export function groupSessionsForDisplay(views: readonly LocalSessionView[]): SessionDisplayGroups {
  return {
    working: views.filter(v => v.state === 'bound'),
    idleOnline: views.filter(v => v.state === 'online'),
    earlier: views.filter(v => v.state === 'offline' || v.state === 'ended'),
  };
}

/**
 * The tasks a session row shows: live claims first, then the rest, newest
 * claim first within each, at most SESSION_TASK_PREVIEW; `hidden` is the rest
 * in the same order (the "+N more" disclosure).
 */
export function sessionTaskPreview(v: Pick<LocalSessionView, 'tasks' | 'task'>, max = SESSION_TASK_PREVIEW): { shown: LocalSessionTaskView[]; hidden: LocalSessionTaskView[] } {
  const all = v.tasks.length > 0
    ? [...v.tasks].reverse()
    : v.task ? [{ ...v.task, workerId: '', live: false }] : [];
  const ordered = [...all.filter(t => t.live), ...all.filter(t => !t.live)];
  return { shown: ordered.slice(0, max), hidden: ordered.slice(max) };
}


/**
 * The ONE way to link to a mission-owned task (spec d25d923d "Navigation: one
 * place per task", R-1).
 *
 * - default: `/app/tasks/Y?from=…` — the task page, the only task view. `from`
 *   (and `initiativeId`) say where the mission was opened from, so the task
 *   page's back link returns to the mission inside that context.
 * - `focus`: `/app/missions/X?from=…#t-Y` — the mission page, landed on the
 *   task's row, scrolled into view and outlined. Used for "back to the row".
 *
 * `?task=` (the retired task sheet) and `?tab=` are never emitted.
 */

import { isValidTaskId } from './task-id';

export type MissionOrigin = 'home' | 'missions' | 'initiative';

export interface MissionTaskHrefInput {
  missionId: string | null | undefined;
  taskId: string;
  from?: MissionOrigin | null;
  /** Required for `from: 'initiative'` breadcrumbs; ignored otherwise. */
  initiativeId?: string | null;
  /** `focus`: the mission page at the task's row. Absent: the task page. */
  mode?: 'focus';
}

const ORIGINS: readonly MissionOrigin[] = ['home', 'missions', 'initiative'];

/**
 * `?from=` / `?initiativeId=` from a URL, narrowed to what links carry
 * forward. An initiative id is kept only with the initiative origin.
 */
export function parseMissionOriginParams(params: { from?: unknown; initiativeId?: unknown }): {
  from: MissionOrigin | null;
  initiativeId: string | null;
} {
  const from = typeof params.from === 'string' && (ORIGINS as readonly string[]).includes(params.from)
    ? (params.from as MissionOrigin)
    : null;
  const initiativeId = from === 'initiative' && typeof params.initiativeId === 'string' && params.initiativeId
    ? params.initiativeId
    : null;
  return { from, initiativeId };
}

const enc = encodeURIComponent;

/** DOM id of a task's row on the mission page. */
export function missionTaskAnchorId(taskId: string): string {
  return `t-${taskId}`;
}

/** Task id from a `#t-<id>` hash, or null for any other (or malformed) hash. Never throws. */
export function parseMissionTaskHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h.startsWith('t-') || h.length <= 2) return null;
  try {
    return decodeURIComponent(h.slice(2));
  } catch {
    // A hand-edited or truncated URL ("#t-%E0") is not a task anchor.
    return null;
  }
}

/** The task's own full page. For a mission task it carries the mission back-link context. */
export function taskPageHref({ taskId, missionId }: { taskId: string; missionId?: string | null }): string {
  const base = `/app/tasks/${enc(taskId)}`;
  return missionId ? `${base}?from=mission&missionId=${enc(missionId)}` : base;
}

/**
 * Where "answer this question" goes: the task page, which is the full
 * answering experience, with its answer box focused (`?respond=1`).
 */
export function taskAnswerHref({ taskId, missionId }: { taskId: string; missionId?: string | null }): string {
  const page = taskPageHref({ taskId, missionId });
  return `${page}${page.includes('?') ? '&' : '?'}respond=1`;
}

export function missionTaskHref({ missionId, taskId, from, initiativeId, mode }: MissionTaskHrefInput): string {
  if (!missionId) return taskPageHref({ taskId });
  const params: string[] = [];
  if (from) params.push(`from=${enc(from)}`);
  if (from === 'initiative' && initiativeId) params.push(`initiativeId=${enc(initiativeId)}`);
  const query = params.length ? `?${params.join('&')}` : '';
  if (mode !== 'focus') return `/app/tasks/${enc(taskId)}${query}`;
  return `/app/missions/${enc(missionId)}${query}#${missionTaskAnchorId(enc(taskId))}`;
}

/**
 * `/app/missions/M?task=T` was the task sheet over the mission. The sheet is
 * retired (spec d25d923d R-2): the same URL lands on T's page, with the back
 * context it carried, and `respond=1` (focus the answer). A mission
 * `?artifact=` stays with the mission: it names a mission artifact.
 * Null when there is no task id, so the mission page renders as before.
 */
export function legacyTaskSheetRedirect(
  missionId: string,
  search: { task?: unknown; from?: unknown; initiativeId?: unknown; respond?: unknown },
): string | null {
  const taskId = typeof search.task === 'string' ? search.task : null;
  if (!isValidTaskId(taskId)) return null;
  const { from, initiativeId } = parseMissionOriginParams(search);
  const href = missionTaskHref({ missionId, taskId, from, initiativeId });
  if (search.respond !== '1') return href;
  return `${href}${href.includes('?') ? '&' : '?'}respond=1`;
}

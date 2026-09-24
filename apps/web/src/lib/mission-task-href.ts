/**
 * The ONE way to link to a mission-owned task
 * (docs/design/mission-feed-mobile-continuity.md, "Interaction, URL and scroll model").
 *
 * - `sheet`: `/app/missions/X?from=…&task=Y` — the mission renders with the task
 *   sheet open over it, so the list behind never loses its place.
 * - `focus`: `/app/missions/X?from=…#t-Y` — lands on the row, scrolled into view
 *   and outlined. A hash change triggers no server render.
 *
 * `?tab=` is retired and never emitted.
 */

export type MissionOrigin = 'home' | 'missions' | 'initiative';

export interface MissionTaskHrefInput {
  missionId: string | null | undefined;
  taskId: string;
  from?: MissionOrigin | null;
  /** Required for `from: 'initiative'` breadcrumbs; ignored otherwise. */
  initiativeId?: string | null;
  mode: 'sheet' | 'focus';
}

const enc = encodeURIComponent;

/** DOM id of a task's row on the mission page. */
export function missionTaskAnchorId(taskId: string): string {
  return `t-${taskId}`;
}

/** Task id from a `#t-<id>` hash, or null for any other hash. */
export function parseMissionTaskHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h.startsWith('t-') || h.length <= 2) return null;
  return decodeURIComponent(h.slice(2));
}

/** The task's own full page. For a mission task it carries the mission back-link context. */
export function taskPageHref({ taskId, missionId }: { taskId: string; missionId?: string | null }): string {
  const base = `/app/tasks/${enc(taskId)}`;
  return missionId ? `${base}?from=mission&missionId=${enc(missionId)}` : base;
}

export function missionTaskHref({ missionId, taskId, from, initiativeId, mode }: MissionTaskHrefInput): string {
  if (!missionId) return taskPageHref({ taskId });
  const params: string[] = [];
  if (from) params.push(`from=${enc(from)}`);
  if (from === 'initiative' && initiativeId) params.push(`initiativeId=${enc(initiativeId)}`);
  if (mode === 'sheet') params.push(`task=${enc(taskId)}`);
  const query = params.length ? `?${params.join('&')}` : '';
  const hash = mode === 'focus' ? `#${missionTaskAnchorId(enc(taskId))}` : '';
  return `/app/missions/${enc(missionId)}${query}${hash}`;
}

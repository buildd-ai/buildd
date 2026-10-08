/**
 * The ONE way to link to a mission-owned task
 * (knowledge-base: buildd/design/mission-feed-mobile-continuity.md, "Interaction, URL and scroll model").
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

// ─── The navigation contract ────────────────────────────────────────────────

/**
 * Whether pointing at a task should be a real navigation (a link the user can
 * open in a new tab, which may leave this page) or an in-page anchor onto
 * something already rendered here (the mission Board's own Landed-strip cell
 * and its tethered drawer). Both are legitimate; what is never legitimate is
 * a navigation-shaped label on an affordance that does not navigate — "Open"
 * promises the reader they will land somewhere, and an anchor never does.
 *
 * Callers own the `inPageAnchor` test (e.g. "is this task already drawn in
 * the strip on this render"); this function owns only the one rule that
 * follows from the answer — so a future surface (a retry CTA, a
 * switch-backend action) asks this instead of inventing its own label.
 */
export type TaskAffordanceMode =
  | { kind: 'navigate'; label: string }
  | { kind: 'anchor'; label: string };

/**
 * Rephrase a navigation label ("Open the failed task", "View the open task")
 * for the anchor case. Idempotent on a label that already reads "Jump to …".
 */
export function jumpToLabel(label: string): string {
  if (/^Jump to\b/i.test(label)) return label;
  const rephrased = label.replace(/^(Open|View)\b/, 'Jump to');
  return rephrased === label ? `Jump to: ${label}` : rephrased;
}

export function taskAffordanceMode(label: string, opts: { inPageAnchor: boolean }): TaskAffordanceMode {
  return opts.inPageAnchor ? { kind: 'anchor', label: jumpToLabel(label) } : { kind: 'navigate', label };
}

/**
 * The full task page's mission context (docs/design/mission-feed-mobile-continuity.md
 * W6, slice S6): which mission, its one state chip, the context pulse ringed on
 * this task, `n / N · PHASE`, ‹ › to the pulse-order siblings' pages, and the
 * up-link to this task's row. Pure.
 *
 * Every number comes from the builders the mission page, the sheet and the Home
 * card already use — `buildMissionCardView` (chip, pulse) and
 * `buildMissionFeedGroups` (position, siblings) — so the task page cannot count
 * a mission differently from the mission itself.
 */
import type { MastheadChip, MastheadPosition } from '@/components/missions/MissionMasthead';
import { buildMissionCardView, toFeedTask, type MissionCardRow } from '@/lib/mission-card-view';
import { buildMissionFeedGroups } from '@/lib/mission-feed-groups';
import type { PulseSegment } from '@/lib/mission-pulse';
import { missionTaskHref, taskPageHref } from '@/lib/mission-task-href';
import { buildTaskSheetNav } from '../../missions/[id]/task-sheet-nav';

export interface MissionContextBarData {
  missionId: string;
  title: string;
  chip: MastheadChip;
  segments: PulseSegment[];
  /** The row this page sits at: the task itself, or the parent an attempt folds under. */
  selectedTaskId: string | null;
  position: MastheadPosition | null;
  /** `/app/missions/X#t-<row>` — lands on the row, scrolled into view and outlined. */
  upHref: string;
}

export function buildMissionContextBar(row: MissionCardRow, taskId: string): MissionContextBarData {
  const card = buildMissionCardView(row, { from: 'missions' });
  const model = buildMissionFeedGroups((row.tasks ?? []).map(toFeedTask));

  let rowId: string | null = model.rowsById.has(taskId) ? taskId : null;
  if (!rowId) {
    for (const r of model.rowsById.values()) {
      if (r.attempts.some(a => a.id === taskId)) { rowId = r.taskId; break; }
    }
  }

  const nav = rowId ? buildTaskSheetNav(model, rowId, { missionId: row.id }) : null;
  const pageHref = (id: string | null) => (id ? taskPageHref({ taskId: id, missionId: row.id }) : null);
  const position: MastheadPosition | null = nav?.position
    ? { ...nav.position, prevHref: pageHref(nav.prevTaskId), nextHref: pageHref(nav.nextTaskId) }
    : null;

  return {
    missionId: row.id,
    title: row.title,
    chip: card.chip,
    segments: card.segments,
    selectedTaskId: rowId,
    position,
    upHref: missionTaskHref({ missionId: row.id, taskId: rowId ?? taskId, mode: 'focus' }),
  };
}

/** The page's gate (AC-13): no mission row, no bar — the breadcrumb renders instead. */
export function missionContextBarFor(
  row: MissionCardRow | null | undefined,
  taskId: string,
): MissionContextBarData | null {
  return row ? buildMissionContextBar(row, taskId) : null;
}

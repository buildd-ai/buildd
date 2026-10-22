/**
 * The task page's sibling stepping in its mission bar (`n / N · <ordinal>
 * <PHASE>` and ‹ ›), from the mission feed model: pulse order, pinned groups
 * never reorder it. Each step is the sibling's own task page, carrying the
 * back context (spec d25d923d R-1). Pure; the model is `buildMissionFeedGroups`
 * output.
 */
import type { MissionFeedModel } from '@/lib/mission-feed-groups';
import { missionTaskHref, type MissionOrigin } from '@/lib/mission-task-href';
import type { MastheadPosition } from '@/components/missions/MissionMasthead';

export interface MissionSiblingNav {
  position: MastheadPosition | null;
  prevTaskId: string | null;
  nextTaskId: string | null;
}

export interface MissionSiblingContext {
  missionId: string;
  from?: MissionOrigin | null;
  initiativeId?: string | null;
}

const EMPTY: MissionSiblingNav = { position: null, prevTaskId: null, nextTaskId: null };

export function buildMissionSiblingNav(
  model: MissionFeedModel | null,
  taskId: string,
  ctx: MissionSiblingContext,
): MissionSiblingNav {
  const row = model?.rowsById.get(taskId);
  if (!model || !row) return EMPTY;
  const href = (id: string | null) =>
    id ? missionTaskHref({ missionId: ctx.missionId, taskId: id, from: ctx.from, initiativeId: ctx.initiativeId }) : null;

  const { n, total, prevTaskId, nextTaskId } = row.position;
  const idx = row.task.missionPhaseIndex ?? null;
  const phase = model.groups.find(
    (g): g is Extract<typeof g, { kind: 'phase' }> => g.kind === 'phase' && g.index !== null && g.index === idx,
  );
  const phaseLabel = phase?.label ? `${phase.ordinal} ${phase.label}` : null;

  return {
    position: { n, total, phaseLabel, prevHref: href(prevTaskId), nextHref: href(nextTaskId) },
    prevTaskId,
    nextTaskId,
  };
}

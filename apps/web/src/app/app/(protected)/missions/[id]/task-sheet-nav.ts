/**
 * What the task sheet's header needs from the mission feed model
 * (docs/design/mission-feed-mobile-continuity.md W4, Grouping rules §6):
 * `n / N · <ordinal> <PHASE>`, the ‹ › siblings in pulse order, and
 * "Next needing you". Pure; the model is `buildMissionFeedGroups` output.
 */
import type { MissionFeedModel } from '@/lib/mission-feed-groups';
import type { MissionFeedTaskInput } from '@/lib/mission-pulse';
import { missionTaskHref, type MissionOrigin } from '@/lib/mission-task-href';
import type { MastheadPosition } from '@/components/missions/MissionMasthead';

export interface TaskSheetNav {
  position: MastheadPosition | null;
  prevTaskId: string | null;
  nextTaskId: string | null;
  nextNeedingYou: { taskId: string; title: string } | null;
}

export interface TaskSheetHrefContext {
  missionId: string;
  from?: MissionOrigin | null;
  initiativeId?: string | null;
}

const EMPTY: TaskSheetNav = { position: null, prevTaskId: null, nextTaskId: null, nextNeedingYou: null };

export function buildTaskSheetNav(
  model: MissionFeedModel | null,
  taskId: string,
  ctx: TaskSheetHrefContext,
): TaskSheetNav {
  if (!model) return EMPTY;
  const href = (id: string | null) =>
    id ? missionTaskHref({ missionId: ctx.missionId, taskId: id, from: ctx.from, initiativeId: ctx.initiativeId, mode: 'sheet' }) : null;

  const nextId = model.nextNeedingYou(taskId);
  const nextRow = nextId ? model.rowsById.get(nextId) : undefined;
  const nextNeedingYou = nextRow ? { taskId: nextRow.taskId, title: nextRow.task.title } : null;

  const row = model.rowsById.get(taskId);
  if (!row) return { ...EMPTY, nextNeedingYou };

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
    nextNeedingYou,
  };
}

type Loose = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const date = (v: unknown): Date | string | null => (v instanceof Date || typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * A mission-page task row → the feed model's input, keeping only the fields
 * the model reads. The page query holds `result`, `context` and artifact
 * content; none of that crosses into the client bundle through here.
 */
export function toMissionFeedTaskInput(t: Loose & { id: string; title: string; status: string }): MissionFeedTaskInput {
  const w = (Array.isArray(t.workers) ? (t.workers[0] as Loose | undefined) : undefined) ?? null;
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    createdAt: date(t.createdAt) ?? new Date(0),
    updatedAt: date(t.updatedAt),
    taskClass: str(t.taskClass),
    parentTaskId: str(t.parentTaskId),
    mode: str(t.mode),
    kind: str(t.kind),
    roleSlug: str(t.roleSlug),
    category: str(t.category),
    creationSource: str(t.creationSource),
    dependsOn: Array.isArray(t.dependsOn) ? (t.dependsOn as unknown[]).filter((d): d is string => typeof d === 'string') : null,
    missionPhaseIndex: num(t.missionPhaseIndex),
    missionPhaseLabel: str(t.missionPhaseLabel),
    worker: w
      ? {
          status: str(w.status) ?? 'unknown',
          startedAt: date(w.startedAt),
          updatedAt: date(w.updatedAt),
          prNumber: num(w.prNumber),
          prUrl: str(w.prUrl),
          prLifecycleStatus: str(w.prLifecycleStatus),
          mergedAt: date(w.mergedAt),
        }
      : null,
  };
}

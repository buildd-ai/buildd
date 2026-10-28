/**
 * The mission page's feed derivation, lifted out of `page.tsx` so it is tested
 * without a database (knowledge-base: buildd/design/mission-feed-mobile-continuity.md, addendum
 * D1). Pure.
 *
 * One `feedTasks` array feeds the header pulse, the list and the task page's
 * mission bar, * so the pulse, the rows and `n / N` all count the same deliverables. Attempts
 * and bookkeeping are folded by the builders, never here.
 */
import { selectMissionRecords } from '@/lib/flight-strip-nav';
import { buildPulseCaption, buildPulseSegments, type MissionFeedTaskInput, type PulseSegment } from '@/lib/mission-pulse';
import { feedStripOrder } from '@/lib/mission-strip-order';


export interface MissionFeedViewTask extends Loose {
  id: string;
  title: string;
  status: string;
  /** Newest first, as the mission query orders them. */
  workers?: unknown[] | null;
}

export interface MissionFeedView {
  feedTasks: MissionFeedTaskInput[];
  pulseSegments: PulseSegment[];
  segmentLabels: Record<string, string>;
  pulseCaption: string;
  /** Review-worthy records per task (`selectMissionRecords`); tasks with none are absent. */
  recordsCountByTask: Record<string, number>;
  /** The latest live worker's current action, per task. */
  liveLines: Record<string, string>;
}

export function buildMissionFeedView(
  tasks: readonly MissionFeedViewTask[],
  opts: { activeAgents: number; liveStatuses: ReadonlySet<string> },
): MissionFeedView {
  const feedTasks = tasks.map(toMissionFeedTaskInput);
  const pulseSegments = buildPulseSegments(feedTasks, { order: feedStripOrder(feedTasks) });
  const segmentLabels = Object.fromEntries(feedTasks.map(t => [t.id, t.title]));
  const pulseCaption = buildPulseCaption(pulseSegments, { liveWorkers: opts.activeAgents });

  const recordsCountByTask: Record<string, number> = {};
  const liveLines: Record<string, string> = {};
  for (const t of tasks) {
    const workers = (Array.isArray(t.workers) ? t.workers : []) as Array<Loose & { artifacts?: unknown[] | null }>;
    const n = selectMissionRecords(workers.flatMap(w => (w.artifacts ?? []) as Parameters<typeof selectMissionRecords>[0])).length;
    if (n > 0) recordsCountByTask[t.id] = n;
    const live = workers[0];
    if (live && typeof live.status === 'string' && opts.liveStatuses.has(live.status) && live.currentAction) {
      liveLines[t.id] = String(live.currentAction);
    }
  }

  return { feedTasks, pulseSegments, segmentLabels, pulseCaption, recordsCountByTask, liveLines };
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
  const milestones = Array.isArray(w?.milestones)
    ? (w.milestones as unknown[])
        .filter((m): m is { ts?: unknown; label?: unknown } => typeof m === 'object' && m !== null)
        .filter((m): m is { ts: number; label: string } => typeof m.ts === 'number' && typeof m.label === 'string')
    : null;
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
          milestones: milestones && milestones.length > 0 ? milestones : null,
        }
      : null,
  };
}

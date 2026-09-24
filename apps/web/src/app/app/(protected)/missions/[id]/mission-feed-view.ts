/**
 * The mission page's feed derivation, lifted out of `page.tsx` so it is tested
 * without a database (docs/design/mission-feed-mobile-continuity.md, addendum
 * D1). Pure.
 *
 * One `feedTasks` array feeds the header pulse, the list and the task sheet,
 * so the pulse, the rows and `n / N` all count the same deliverables. Attempts
 * and bookkeeping are folded by the builders, never here.
 */
import { selectMissionRecords } from '@/lib/flight-strip-nav';
import { buildPulseCaption, buildPulseSegments, type MissionFeedTaskInput, type PulseSegment } from '@/lib/mission-pulse';
import { toMissionFeedTaskInput } from './task-sheet-nav';

type Loose = Record<string, unknown>;

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
  const pulseSegments = buildPulseSegments(feedTasks);
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

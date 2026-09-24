/**
 * Server loader for mission cards (docs/design/mission-feed-mobile-continuity.md,
 * S5). The pure model is `mission-card-view.ts`; this adds the one extra read a
 * card needs that its page did not already make — the human steering marks the
 * time-axis strip in `FlightDetailSheet` draws — batched into a single query and
 * capped to the missions the surface actually shows.
 *
 * Callers select `MISSION_CARD_TASK_COLUMNS` / `MISSION_CARD_WORKER_COLUMNS` on
 * their own mission query, so the card never costs a second task fan-out.
 */
import { computeMissionFlightStrip } from '@buildd/core/mission-helpers';
import { loadHumanSteeringMarksByMission } from './mission-steering-notes';
import { adaptFlightStripInputs } from './missions-query';
import {
  buildMissionCardView,
  MISSION_CARD_VIEW_CAP,
  type BlockingTask,
  type MissionCardRow,
  type MissionCardSummary,
  type MissionCardView,
} from './mission-card-view';
import type { MissionOrigin } from './mission-task-href';

/** Task columns a card reads (pulse, feed state, situation, health, schedule timing). */
export const MISSION_CARD_TASK_COLUMNS = {
  id: true, title: true, status: true, createdAt: true, updatedAt: true, kind: true, mode: true,
  creationSource: true, category: true, parentTaskId: true, dependsOn: true, scheduleId: true,
  startAt: true, loopIteration: true, taskClass: true, roleSlug: true,
  missionPhaseIndex: true, missionPhaseLabel: true,
} as const;

/** Worker columns a card reads (liveness, PR state, and the strip's spans). */
export const MISSION_CARD_WORKER_COLUMNS = {
  id: true, status: true, startedAt: true, completedAt: true, updatedAt: true, turns: true,
  prUrl: true, mergedAt: true, prNumber: true, prLifecycleStatus: true, supersededByPrNumber: true,
  exitCause: true,
} as const;

/**
 * The nested worker relation a card query uses: newest attempt first, so a
 * live re-claim is always inside the per-task limit.
 */
export const MISSION_CARD_WORKERS_WITH = {
  columns: MISSION_CARD_WORKER_COLUMNS,
  limit: 5,
  orderBy: (w: any, { desc }: any) => [desc(w.startedAt), desc(w.updatedAt)],
} as const;

/** Most cards one surface builds in a request. Home shows active + ≤ 3 scheduled. */
export { MISSION_CARD_VIEW_CAP };

export async function loadMissionCardViews(
  rows: readonly MissionCardRow[],
  opts: {
    from: MissionOrigin;
    now?: number;
    summaries?: ReadonlyMap<string, MissionCardSummary>;
    taskIndex?: ReadonlyMap<string, BlockingTask>;
  },
): Promise<Map<string, MissionCardView>> {
  const visible = rows.slice(0, MISSION_CARD_VIEW_CAP);
  const now = opts.now ?? Date.now();
  // Only an unfinished mission's strip is drawn live (completed cards are compact).
  const liveIds = visible.filter(r => !['completed', 'archived', 'cancelled'].includes(r.status)).map(r => r.id);
  const steering = liveIds.length > 0 ? await loadHumanSteeringMarksByMission(liveIds) : new Map();

  const views = new Map<string, MissionCardView>();
  for (const row of visible) {
    const live = liveIds.includes(row.id);
    const flightStrip = live
      ? (() => {
          const { tasks, workers } = adaptFlightStripInputs((row.tasks ?? []) as any[]);
          return computeMissionFlightStrip(tasks, workers, {
            missionCompletedAt: (row.completedAt as any) ?? null,
            steeringEvents: steering.get(row.id),
          });
        })()
      : null;
    views.set(row.id, buildMissionCardView(row, {
      from: opts.from, now, flightStrip, summary: opts.summaries?.get(row.id), taskIndex: opts.taskIndex,
    }));
  }
  return views;
}

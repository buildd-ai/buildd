/**
 * Home's hook into the stored mission summary (spec 3ef37387 R-13), filled
 * by the composition root (modules.ts `HOME_MISSION_SUMMARIES`): Home reads
 * the stored rows itself, and comes here for the missions that have none yet,
 * to note summaries for writing after the response, and to file a visual
 * review a mission PR owes (also after the response).
 */
import { computeMissionSummary, homeReadingOf, type MissionHomeReading } from './mission-summary';
import { loadMissionSummaryInputs } from './mission-summary-load';
import { refreshMissionSummary } from './mission-summary-store';
import { missionWorkHolder, missionWorkStateFromRows } from './mission-work-state';

export interface LiveHomeReading {
  id: string;
  title: string;
  status: string;
  completedAt: Date | null;
  home: MissionHomeReading;
  computedAt: number;
  /** An integration-branch mission's mission-PR work holder (`missionWorkHolder`), else null. */
  workHolder: string | null;
}

/**
 * Home's reading of missions whose stored summary is missing, derived live
 * the way the store derives it, without the visual review: a page must not
 * reach GitHub, and the stored summary (written after the response) has it.
 */
export async function deriveHomeReadings(ids: string[], now: number): Promise<LiveHomeReading[]> {
  const inputs = await loadMissionSummaryInputs(ids, { visualReview: false });
  return [...inputs.values()].map(input => {
    const m = input.missionRows[0] as Record<string, any>;
    return {
      id: m.id, title: m.title, status: m.status, completedAt: m.completedAt ?? null,
      home: homeReadingOf(computeMissionSummary(input, now)), computedAt: now,
      workHolder: m.integrationBranchEnabled === true
        ? missionWorkHolder(missionWorkStateFromRows(m as never, input.taskRows as never, input.workerRows as never))
        : null,
    };
  });
}

/** File the visual review a mission PR owes. Best-effort and idempotent; a page calls it after its response. */
export async function scheduleOwedVisualReview(missionId: string): Promise<void> {
  try {
    await (await import('./workflow/visual-review-schedule-run')).scheduleMissionVisualReview(missionId);
  } catch (err) {
    console.error('[home] could not schedule the visual review:', err);
  }
}

export const homeMissionSummaries = {
  derive: deriveHomeReadings,
  /** Note missions for a summary write after the response (coalesced per request). */
  refresh: refreshMissionSummary,
  scheduleVisualReview: scheduleOwedVisualReview,
};

/**
 * The visual review a mission card reads, loaded once per page for the
 * missions where it can still say something (spec 8e137fdb I-1, I-5).
 *
 * A card reads the review only while its audit is open or a `[surface fix]`
 * from it is still being worked: a finished round with nothing open says
 * nothing the card would show, and loading it costs one model read per mission.
 */
import { OPEN_TASK_STATUSES } from '@buildd/shared';
import { isSurfaceAuditTask, isSurfaceFixTask } from '@buildd/core/surface-audit';
import { summarizeVisualReview, type MissionVisualReviewSummary } from './mission-open-checks';
import { getMissionVisualReviewState } from './workflow/visual-review-state-load';

const OPEN: ReadonlySet<string> = new Set(OPEN_TASK_STATUSES);

type CardMission = { id: string; status: string; tasks?: ReadonlyArray<{ title?: string | null; status: string }> | null };

/** Does this mission's card need the visual review read? An open audit or an open fix from one. */
export function cardReadsVisualReview(m: CardMission): boolean {
  if (m.status === 'completed' || m.status === 'archived') return false;
  return (m.tasks ?? []).some(t => OPEN.has(t.status) && (isSurfaceAuditTask(t.title ?? '') || isSurfaceFixTask(t.title)));
}

/** One summary per mission that needs it; the rest are absent (read as no review state). */
export async function loadCardVisualReviews(
  missions: readonly CardMission[],
  load: (id: string) => ReturnType<typeof getMissionVisualReviewState> = getMissionVisualReviewState,
): Promise<Map<string, MissionVisualReviewSummary | null>> {
  const ids = missions.filter(cardReadsVisualReview).map(m => m.id);
  return new Map(await Promise.all(ids.map(async id => [id, summarizeVisualReview(await load(id).catch(() => null))] as const)));
}

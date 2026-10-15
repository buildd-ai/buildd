/**
 * The mission facts a card's delivery line reads beyond its tasks: whether the
 * mission PR merged, the visual review, open required checks and a local
 * strand. One builder for the missions list and Home, so the two cards and the
 * mission page name the same state (spec 8e137fdb I-1).
 */
import { deriveLocalStrand } from './local-strand';
import { deriveMissionIntegrationPr } from './mission-integration-pr';
import { openCriteriaCount, type MissionVisualReviewSummary } from './mission-open-checks';
import type { MissionDeliveryInput } from './delivery-projection';

type FactsMission = Parameters<typeof deriveMissionIntegrationPr>[0]['mission'] & {
  status: string;
  executor?: string | null;
  isHeld?: boolean | null;
  integrationBranchEnabled?: boolean | null;
  goalCriteria?: unknown;
  goalCriteriaState?: unknown;
  tasks?: unknown[] | null;
};

export function missionDeliveryFacts(
  m: FactsMission,
  visualReview: MissionVisualReviewSummary | null | undefined,
  now: number,
): Pick<MissionDeliveryInput, 'missionPrMerged' | 'visualReview' | 'criteriaPending' | 'localStrand'> {
  const tasks = (m.tasks ?? []) as never[];
  const missionPrMerged = deriveMissionIntegrationPr({ mission: m, tasks })?.state === 'merged';
  return {
    // R-32: a merged mission PR puts the work on trunk; the row says what is left.
    missionPrMerged,
    visualReview: visualReview ?? null,
    // AC-7: every open required check, the selected outcome spec included.
    criteriaPending: openCriteriaCount(m.goalCriteria, m.goalCriteriaState, {
      branch: m.integrationBranchEnabled === true ? 'mission-branch' : 'direct',
      prMerged: missionPrMerged,
      buildComplete: true,
    }),
    localStrand: deriveLocalStrand({ executor: m.executor ?? null, isHeld: m.isHeld ?? false, status: m.status, tasks, now }),
  };
}

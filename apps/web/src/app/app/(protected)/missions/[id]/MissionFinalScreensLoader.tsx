/**
 * Loads the follow-ups filed for findings the fix rounds left open, then
 * renders the Final screens. Kept out of the mission page so its render
 * waterfall does not grow by one wait.
 */
import type { VisualReviewModel } from '@buildd/shared';
import { listExhaustedFollowUps, type ExhaustedFollowUp } from '@/lib/visual-review-exhausted';
import MissionFinalScreens from './MissionFinalScreens';

export default async function MissionFinalScreensLoader({ missionId, model }: { missionId: string; model: VisualReviewModel }) {
  const followUps = (model.exhaustedFindings?.length ?? 0) > 0
    ? await listExhaustedFollowUps(missionId).catch((): ExhaustedFollowUp[] => [])
    : [];
  return <MissionFinalScreens model={model} followUps={followUps} />;
}

'use client';

/**
 * What the visual review's decision card does on each option (the card is
 * shared and cannot import mission code, so the mission page passes this in):
 * Mark all fixed decides every listed screen `looks_right`, Review screens
 * opens the deck (or the mission page when no deck is mounted), Skip the
 * review records the person's waiver. Throws with the server's message.
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { DecisionView } from '@/lib/needs-you-card';
import { visualReviewDecisionsUrl } from '@/components/visual-review/review-transport';
import { VISUAL_REVIEW_SKIP_REASONS, isVisualReviewSkipReason } from '@buildd/core/surface-audit';
import { REVIEW_SCREENS } from '@/lib/visual-review-decision';
import { saveSurfaceAuditWaiver } from './MissionSurfaceAuditWaiver';
import { useMissionVisualReview } from './MissionVisualReview';

export function useVisualDecisionAct(view: DecisionView): ((label: string) => Promise<void>) | undefined {
  const router = useRouter();
  const answer = view.answer.kind === 'visual' ? view.answer : null;
  const review = useMissionVisualReview(answer?.missionId);
  return useCallback(async (label: string) => {
    if (!answer) return;
    if (label === REVIEW_SCREENS) {
      if (review) review.openDeck(answer.startKey);
      else router.push(answer.reviewHref);
      return;
    }
    const skip = Object.keys(VISUAL_REVIEW_SKIP_REASONS).find(k => VISUAL_REVIEW_SKIP_REASONS[k as keyof typeof VISUAL_REVIEW_SKIP_REASONS] === label);
    if (skip && isVisualReviewSkipReason(skip)) {
      const out = await saveSurfaceAuditWaiver(answer.missionId, { reason: skip });
      if (!out.ok) throw new Error(out.error);
      return;
    }
    for (const g of answer.markFixed) {
      const res = await fetch(visualReviewDecisionsUrl(answer.missionId), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ artifactIds: g.artifactIds, decision: 'looks_right', expected: g.expected }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || 'Could not record the decision.');
      }
    }
  }, [answer, review, router]);
}

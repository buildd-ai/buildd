/**
 * An in-memory `VisualReviewTransport` over a fixture model, so the review
 * deck is fully clickable in /app/dev/fixtures (and the dev chat page) with no
 * server and no database. It plays the decisions route's rules closely enough
 * to see the loop: the relation from the agent's verdict, one fix filed per
 * decision, a pending auditor fix cancelled by a waive, a 409 stale when the
 * expected verdict no longer matches, and undo that refuses once a fix left
 * pending. Illustrative data only.
 */
import {
  visualReviewRelation,
  type HumanShotReview,
  type VisualReviewDecisionRequest,
  type VisualReviewDecisionResponse,
  type VisualReviewModel,
  type VisualReviewPhase,
  type VisualReviewUndoResponse,
} from '@buildd/shared';
import { surfaceFixTitle } from '@buildd/core/surface-audit';
import { buildVisualReviewModel, type VisualReviewTaskInput } from '@/lib/visual-review-model';
import {
  VISUAL_REVIEW_FIXTURE_NOW,
  visualReviewFixtureInput,
  withFixtureImages,
  type VisualReviewFixtureOptions,
} from '@/lib/visual-review-model.fixtures';
import { VisualReviewRequestError, type VisualReviewTransport } from './review-transport';

export interface FixtureTransportConfig {
  /** Simulated round trip, so the optimistic state is visible. Default 0. */
  latencyMs?: number;
  /** The first decision answers 409 stale, to show the recovery. */
  staleOnce?: boolean;
}

export interface FixtureVisualReviewTransport extends VisualReviewTransport {
  /** The model as the fixture "server" holds it now. */
  model(): VisualReviewModel;
}

export function createFixtureVisualReviewTransport(
  phase: VisualReviewPhase,
  opts: VisualReviewFixtureOptions = {},
  cfg: FixtureTransportConfig = {},
): FixtureVisualReviewTransport {
  const live: HumanShotReview[] = [];
  const superseded = new Set<string>();
  const statusOf = new Map<string, string>();
  const added: VisualReviewTaskInput[] = [];
  let seq = 0;
  let staleLeft = cfg.staleOnce ? 1 : 0;
  const clock = () => VISUAL_REVIEW_FIXTURE_NOW + seq * 1000;

  function reviewsNow(): HumanShotReview[] {
    const base = visualReviewFixtureInput(phase, opts).reviews ?? [];
    return [...base, ...live].map(r => (superseded.has(r.id) && !r.supersededAt ? { ...r, supersededAt: new Date(clock()).toISOString() } : r));
  }

  function build(): VisualReviewModel {
    const input = visualReviewFixtureInput(phase, opts);
    const tasks = [...input.tasks, ...added].map(t => (statusOf.has(t.id) ? { ...t, status: statusOf.get(t.id)! } : t));
    return withFixtureImages(buildVisualReviewModel({ ...input, tasks, reviews: reviewsNow(), now: clock() }), opts);
  }

  const wait = () => (cfg.latencyMs ? new Promise(r => setTimeout(r, cfg.latencyMs)) : Promise.resolve());
  const taskStatus = (m: VisualReviewModel, id: string) => m.fixTasks.find(f => f.id === id)?.status ?? statusOf.get(id) ?? null;

  return {
    model: build,

    async decide(req: VisualReviewDecisionRequest): Promise<VisualReviewDecisionResponse> {
      await wait();
      const before = build();
      const cells = req.artifactIds.map(id => before.cells.find(c => c.current.shot.id === id));
      const missing = req.artifactIds.filter((_, i) => !cells[i]);
      if (missing.length) throw new VisualReviewRequestError(422, { error: 'not_in_mission', artifactIds: missing });
      const stale = cells.filter(c => c && req.expected[c.current.shot.id] !== c.current.agentVerdict);
      if (stale.length || staleLeft > 0) {
        staleLeft = Math.max(0, staleLeft - 1);
        throw new VisualReviewRequestError(409, { error: 'stale', stale: true, cells: stale.length ? stale : cells, model: before });
      }
      seq++;

      let fixTaskId: string | null = null;
      let cancelledFixTaskId: string | null = null;
      let guidanceTaskId: string | null = null;
      const filing = cells.filter(c => c && req.decision === 'needs_fix' && c.current.agentVerdict !== 'issue');
      if (filing.length) {
        const first = filing[0]!;
        fixTaskId = `fixture-human-fix-${seq}`;
        added.push({
          id: fixTaskId,
          title: surfaceFixTitle(first.route, req.note?.trim() || first.current.finding),
          status: 'pending',
          createdAt: new Date(clock()).toISOString(),
          updatedAt: new Date(clock()).toISOString(),
          workers: [],
        });
      }

      const reviews: HumanShotReview[] = [];
      for (const c of cells) {
        if (!c) continue;
        const active = reviewsNow().find(r => r.artifactId === c.current.shot.id && !r.supersededAt);
        if (active) superseded.add(active.id);
        const verdict = c.current.agentVerdict;
        let cancelled: string | null = null;
        if (req.decision === 'looks_right' && verdict === 'issue' && c.current.fixTask) {
          const fix = c.current.fixTask;
          if (taskStatus(before, fix.id) === 'pending') {
            statusOf.set(fix.id, 'cancelled');
            cancelled = cancelledFixTaskId = fix.id;
          } else if (fix.status !== 'completed' && fix.status !== 'cancelled') {
            guidanceTaskId = fix.id;
          }
        }
        const review: HumanShotReview = {
          id: `fixture-live-review-${seq}-${reviews.length + 1}`,
          artifactId: c.current.shot.id,
          auditTaskId: c.current.shot.auditTaskId,
          round: c.current.round,
          cellKey: c.key,
          route: c.route,
          viewport: c.viewport,
          agentVerdict: verdict,
          decision: req.decision,
          relation: visualReviewRelation(verdict, req.decision),
          note: req.note?.trim() || null,
          fixTaskId: filing.includes(c) ? fixTaskId : null,
          cancelledFixTaskId: cancelled,
          reviewerUserId: null,
          reviewerLabel: 'You',
          createdAt: new Date(clock()).toISOString(),
          supersededAt: null,
        };
        live.push(review);
        reviews.push(review);
      }
      return { reviews, fixTaskId, cancelledFixTaskId, guidanceTaskId, model: build() };
    },

    async undo(reviewId: string): Promise<VisualReviewUndoResponse> {
      await wait();
      const review = reviewsNow().find(r => r.id === reviewId);
      if (!review || review.supersededAt) throw new VisualReviewRequestError(404, { error: 'not_found' });
      let cancelledFixTaskId: string | null = null;
      let reopenedFixTaskId: string | null = null;
      if (review.fixTaskId) {
        // Another review of the same decision may have cancelled it already.
        const status = statusOf.get(review.fixTaskId) ?? added.find(t => t.id === review.fixTaskId)?.status;
        if (status !== 'pending' && status !== 'cancelled') {
          throw new VisualReviewRequestError(409, { error: 'fix_started', fixTaskId: review.fixTaskId });
        }
        if (status === 'pending') {
          statusOf.set(review.fixTaskId, 'cancelled');
          cancelledFixTaskId = review.fixTaskId;
        }
      }
      if (review.cancelledFixTaskId) {
        statusOf.set(review.cancelledFixTaskId, 'pending');
        reopenedFixTaskId = review.cancelledFixTaskId;
      }
      seq++;
      superseded.add(reviewId);
      return { superseded: reviewId, reopenedFixTaskId, cancelledFixTaskId, model: build() };
    },
  };
}

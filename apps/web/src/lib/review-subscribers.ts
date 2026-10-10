/**
 * Reviews module: what a PR closing, and a review submitted on GitHub, mean
 * for buildd's own review loop. The GitHub webhook emits the facts
 * (lib/core-events.ts); this file reacts.
 *
 * - `pr.close_delivered` (every delivery, any PR): the sticky activity comment
 *   stops spinning, and an on-demand review waiting on the PR is told it closed.
 * - `pr.closed` (a worker-owned PR, every delivery), in this order:
 *     1. the merge measured against its review verdict (first delivery of a
 *        merge only; it must read the verdict before step 3 supersedes the
 *        reviewer);
 *     2. a PR closed unmerged: where did its work go (after());
 *     3. supersession: cancel what the close made obsolete;
 *     4. dead-PR shutdown: close buildd-authored losers (fire-and-forget).
 * - `pr.review_submitted` / `pr.review_comment_created`: review text is
 *   captured for retrieval (deduped on GitHub's id), then a person's verdict
 *   on a mission PR goes on the mission timeline. Neither merges, completes a
 *   task, or clears a review gate.
 *
 * What stays in core: landing a PR, auto-merge safety and the merge tier
 * decision, and the review-verdict gate at a merge door.
 */
import { after } from 'next/server';
import { db } from '@buildd/core/db';
import { missionNotes, reviewFeedback } from '@buildd/core/db/schema';
import { subscriber, type AnySubscriber, type EventOf, type PrOwnerFact } from '@/lib/core-events';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import { deliverPrReviewCallback, readPrReviewStatus } from '@/lib/pr-review-request';
import { classifyMergeAgainstReview } from '@/lib/review-verdict-gate';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import { detectPrSupersession } from '@/lib/pr-supersession-detect';
import { reconcileSubjectEvent } from '@/lib/supersession';
import { shutdownDeadBuilddPrs } from '@/lib/dead-pr-shutdown';
import { reviewRowFromEvent, commentRowFromEvent, withOwner, type ReviewFeedbackRow } from '@/lib/review-feedback';

/**
 * A PR merged, measured against its agent review. A merge while a
 * request-changes or escalate verdict was outstanding is `merged_over_verdict`;
 * a merge no verdict covered is `merged_unreviewed`. Best-effort.
 */
async function measureMergeAgainstReview(e: EventOf<'pr.closed'>): Promise<void> {
  if (!e.merged || !e.mergeIsNew) return;
  try {
    const status = await readPrReviewStatus({ workspaceId: e.workspaceId, prNumber: e.prNumber });
    const merge = classifyMergeAgainstReview(status, e.headSha);
    if (!merge) return;
    fireGateEvent({
      gate: GATE_SLUGS.REVIEW_VERDICT,
      surface: 'webhook pull_request.closed (merged)',
      outcome: merge.event === 'merged_over_verdict' ? 'bypassed' : 'warned',
      reason: merge.event === 'merged_over_verdict'
        ? 'PR merged while a reviewer verdict against it was outstanding'
        : 'PR merged with no reviewer verdict covering the merged commit',
      workspaceId: e.workspaceId,
      taskId: e.taskId,
      workerId: e.workerId,
      callerOrigin: 'system',
      detail: {
        event: merge.event,
        prNumber: e.prNumber,
        mergedHeadSha: e.headSha,
        reviewState: merge.state,
        reviewKind: merge.kind,
        reviewTaskId: merge.reviewTaskId,
        reviewHeadSha: merge.reviewHeadSha,
      },
    });
  } catch (err) {
    console.error(`[webhook] merge review telemetry failed for PR #${e.prNumber}:`, err);
  }
}

/**
 * Persist one piece of review feedback for later retrieval, so the next agent
 * about to edit a file can be shown what a reviewer already said about it.
 * Idempotent on GitHub's id (`onConflictDoNothing` against the unique
 * `github_id`): the webhook both drops and redelivers. Never throws.
 */
async function captureReviewFeedback(
  row: ReviewFeedbackRow | null,
  owner: PrOwnerFact | null,
  pr: { repoFullName: string; prNumber: number },
): Promise<void> {
  if (!row || !owner?.workspaceId) return;
  try {
    await db.insert(reviewFeedback).values({
      ...withOwner(row, { id: owner.workerId, taskId: owner.taskId, workspaceId: owner.workspaceId }),
      workspaceId: owner.workspaceId,
      repoFullName: pr.repoFullName,
      prNumber: pr.prNumber,
    }).onConflictDoNothing();
  } catch (err) {
    console.warn('[webhook] review feedback capture failed (non-fatal):', err);
  }
}

export const reviewSubscribers: readonly AnySubscriber[] = [
  // ── pr.close_delivered ─────────────────────────────────────────────────────
  // The PR closing is the last word, so a header left on a working state must
  // stop spinning. onlyIfPresent: a PR buildd never announced on stays
  // comment-free. Idempotent: an unchanged last entry is not re-posted.
  subscriber('reviews', 'pr.close_delivered', 'pr-activity-on-close', async e => {
    if (e.installationId == null) return;
    await appendPrActivity({
      installationId: e.installationId,
      repoFullName: e.repoFullName,
      prNumber: e.prNumber,
      entry: e.merged
        ? { kind: 'merged', detail: e.baseRef ? `into \`${e.baseRef}\`` : null }
        : { kind: 'closed_unmerged' },
      onlyIfPresent: true,
      workspaceId: e.workspaceId,
    });
  }),
  // An on-demand review can wait on the PR itself (`callbackOn: 'merge'`), and
  // a PR closed mid-review never reaches a verdict: either way, tell the
  // requester now. Single-fire inside the helper.
  subscriber('reviews', 'pr.close_delivered', 'review-callback-on-close', async e => {
    if (!e.workspaceId) return;
    await deliverPrReviewCallback({ workspaceId: e.workspaceId, prNumber: e.prNumber, repoFullName: e.repoFullName });
  }),

  // ── pr.closed ──────────────────────────────────────────────────────────────
  subscriber('reviews', 'pr.closed', 'merge-review-telemetry', measureMergeAgainstReview),
  // Claims and sibling tasks only nominate; an edge is recorded only if the
  // content verifies. GitHub-heavy, so after(); the hourly pr-reconcile sweep
  // is the backstop.
  subscriber('reviews', 'pr.closed', 'supersession-detect-on-close', async e => {
    if (e.merged) return;
    // A kernel-owned PR's scan is the `scan_supersession` effect its close (T18) recorded.
    // A failed ownership read falls back to scanning here: detection is idempotent and a
    // kernel-owned PR's edge still goes through T20 (recordPrSupersession).
    const owned = await import('@/lib/workflow/authority')
      .then(m => m.kernelDeliveryForPr(e.workspaceId, e.repoFullName, e.prNumber))
      .catch(() => null);
    if (owned) return;
    const detect = () => detectPrSupersession({ workerId: e.workerId, via: 'webhook' }).then(
      r => console.log(`[webhook] supersession detection for PR #${e.prNumber}: ${r.outcome}`),
      err => console.error(`[webhook] supersession detection failed for PR #${e.prNumber}:`, err),
    );
    try {
      after(detect);
    } catch {
      await detect();
    }
  }),
  // The reconciler cancels what the close made obsolete: a live reviewer and
  // open fixes on a merge, unstarted fixes on a close, and anchored tasks whose
  // subject is now dead. Idempotent; never throws.
  subscriber('reviews', 'pr.closed', 'supersession-reconcile-on-close', async e => {
    // A kernel-owned PR's close (T18) or merge (T17) carries its own
    // `cancel_open_attempts`, which ends each attempt in the ledger; a casCancel
    // here would be a second authority with no AttemptEnded, and a reopen (T19)
    // could find a row still `queued` (spec §14). A failed ownership read falls
    // back to the reconciler, like the detect sibling above. Tasks merely
    // anchored to the PR are left to the hourly subject_check sweep.
    const owned = await import('@/lib/workflow/authority')
      .then(m => m.kernelDeliveryForPr(e.workspaceId, e.repoFullName, e.prNumber))
      .catch(() => null);
    if (owned) return;
    await reconcileSubjectEvent({
      kind: e.merged ? 'merged' : 'closed',
      workspaceId: e.workspaceId,
      prNumber: e.prNumber,
      originalTaskId: e.taskId,
      door: `webhook pull_request.closed${e.merged ? ' (merged)' : ''}`,
      pr: e.installationId != null ? { installationId: e.installationId, repoFullName: e.repoFullName } : null,
    });
  }),
  // Close buildd-authored loser PRs superseded by this one, when the workspace
  // has autoCloseBuilddSupersededPrs. Fire-and-forget, as it always was.
  subscriber('reviews', 'pr.closed', 'dead-pr-shutdown', e => {
    if (e.installationId == null) return;
    shutdownDeadBuilddPrs(e.workspaceId, e.prNumber, e.merged, e.installationId, e.repoFullName).catch(err =>
      console.error(`[webhook] dead-pr-shutdown failed for PR #${e.prNumber}:`, err),
    );
  }),

  // ── pr.review_submitted / pr.review_comment_created ───────────────────────
  // Capture runs before the verdict note, and ignores both of its gates: a
  // reviewer explaining a problem without formally requesting changes, or on a
  // PR outside a mission, is exactly the content retrieval wants.
  subscriber('reviews', 'pr.review_submitted', 'capture-review-feedback', async e => {
    await captureReviewFeedback(reviewRowFromEvent(e.review), e.owner, e);
  }),
  // A human (or an outside bot) reviewed a PR in GitHub's own UI. GitHub sends
  // approved | changes_requested | commented; a bare comment is not a verdict.
  // Deliberately record-only: it does not satisfy the `agent-review` gate,
  // trigger auto-merge, or complete a task. Whether a GitHub approval should
  // clear buildd's review gate is a policy question (the merge-policy tier
  // placement crux), and answering it by side effect would silently change when
  // things merge.
  subscriber('reviews', 'pr.review_submitted', 'github-verdict-mission-note', async e => {
    const state = String(e.review.state ?? '').toLowerCase();
    const noteType =
      state === 'approved' ? 'reviewer_approved' as const
      : state === 'changes_requested' ? 'reviewer_request_changes' as const
      : null;
    if (!noteType) return;
    const missionId = e.owner?.missionId;
    if (!missionId) return;
    const reviewer = typeof e.review.user?.login === 'string' ? e.review.user.login : 'a reviewer';
    const verdict = noteType === 'reviewer_approved' ? 'approved' : 'requested changes';
    const body = String(e.review.body ?? '').trim();
    await db.insert(missionNotes).values({
      missionId,
      taskId: e.owner?.taskId ?? null,
      workerId: e.owner?.workerId ?? null,
      // 'user': a person acting on the PR in GitHub, not a worker inside a task.
      authorType: 'user',
      type: noteType,
      title: `PR #${e.prNumber} ${verdict} on GitHub`,
      body: body.length > 0 ? body : null,
      actorLabel: `${reviewer} (GitHub review)`,
    });
    console.log(
      `[webhook] pull_request_review: ${reviewer} ${verdict} PR #${e.prNumber} `
      + `(mission ${missionId}) — recorded, merge behaviour unchanged`,
    );
  }),
  // Inline comments carry path, line and diff_hunk: what makes an objection
  // retrievable by the file it concerns.
  subscriber('reviews', 'pr.review_comment_created', 'capture-review-comment', async e => {
    await captureReviewFeedback(commentRowFromEvent(e.comment), e.owner, e);
    if (e.owner?.workspaceId) console.log(`[webhook] review comment captured: PR #${e.prNumber} ${e.comment.path ?? '(no path)'}`);
  }),
  // Hourly backstop: older integration-refresh PRs a newer merged refresh fully
  // replaced are verified and retired (lib/pr-supersession-refresh.ts). Idempotent.
  subscriber('reviews', 'sweep.pr_hourly', 'superseded-refresh-sweep', async () => {
    const { sweepSupersededRefreshPrs } = await import('@/lib/pr-supersession-refresh');
    const r = await sweepSupersededRefreshPrs();
    console.log(`[SupersededRefreshPrs] candidates=${r.candidates} retired=${r.retired} kept=${r.kept} skipped=${r.skipped}`);
  }),
];

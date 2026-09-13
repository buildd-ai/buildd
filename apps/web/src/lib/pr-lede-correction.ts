/**
 * Applying a reviewer's corrected lede to the PR body.
 *
 * THE DIVISION OF LABOUR IS THE POINT. Reviewer tasks are read-only and never
 * touch the PR — the agent PROPOSES (`correctedLede` on its output schema) and
 * the server APPLIES, exactly as it already does for the verdict itself and for
 * the activity comment `appendPrActivity` writes on the reviewer's behalf. The
 * reviewer agent is never given write access to the PR body.
 *
 * THIS MUST NEVER GATE THE VERDICT. Every failure here — GitHub down, body
 * unreadable, PATCH rejected, no lede block to replace — is logged and dropped,
 * and this function resolves rather than throws. The verdict lands unchanged
 * either way. A body edit is cosmetic; a verdict is not.
 *
 * THE ORIGINAL IS NEVER LOST. `applyLedeCorrection` keeps the author's own
 * sentence in the block, both as prose a human reads and as a machine-readable
 * marker, so the substitution is auditable and later retrieval cannot mistake
 * the reviewer's rewrite for the author's account. This module additionally
 * records the correction on the PR's buildd activity comment.
 */

import { applyLedeCorrection, normalizeLede } from '@buildd/core/pr-lede';
import { appendPrActivity } from './pr-activity-comment';

export interface ApplyReviewerLedeCorrectionParams {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  /** The reviewer's proposed replacement. Undefined on almost every review. */
  correctedLede?: string | null;
  workspaceId?: string | null;
}

export type ApplyReviewerLedeCorrectionResult =
  | { applied: true; original: string; corrected: string }
  | { applied: false; reason: string };

/**
 * Replace the PR body's lede with the reviewer's corrected one.
 *
 * Returns `{ applied: false, reason }` for every non-application, including the
 * common case where the reviewer proposed nothing — in which case NOTHING is
 * fetched and NOTHING is written, so a review that leaves the lede alone costs
 * no GitHub calls and cannot perturb the body.
 */
export async function applyReviewerLedeCorrection(
  params: ApplyReviewerLedeCorrectionParams,
): Promise<ApplyReviewerLedeCorrectionResult> {
  const { installationId, repoFullName, prNumber, workspaceId } = params;

  const corrected = normalizeLede(params.correctedLede);
  // The overwhelmingly common path: the lede was fine and the reviewer said
  // nothing about it. Leave before touching GitHub at all.
  if (!corrected) return { applied: false, reason: 'no correction proposed' };

  try {
    const { githubApi } = await import('@/lib/github');
    const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
    const body = typeof pr?.body === 'string' ? pr.body : null;

    const next = applyLedeCorrection(body, corrected);
    if (!next) {
      // No lede block to replace (an externally-opened PR, or one predating the
      // field), or the correction matches what is already there. Either way the
      // body is left exactly as the author wrote it.
      return { applied: false, reason: 'no lede block to correct' };
    }

    await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: next.body }),
    });

    // Best-effort audit trail on the PR itself, so the substitution is visible
    // to a human who never opens the dashboard. Failing this must not turn a
    // successful correction into a reported failure.
    await appendPrActivity({
      installationId,
      repoFullName,
      prNumber,
      entry: {
        kind: 'lede_corrected',
        detail: `was “${next.original}”`,
      },
      onlyIfPresent: true,
      workspaceId,
    }).catch(() => {});

    console.log(
      `[reviewer] corrected the lede on PR #${prNumber} — the original contradicted the diff`,
    );
    return { applied: true, original: next.original, corrected: next.corrected };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[reviewer] could not apply the corrected lede to PR #${prNumber} (verdict unaffected): ${reason}`,
    );
    return { applied: false, reason };
  }
}

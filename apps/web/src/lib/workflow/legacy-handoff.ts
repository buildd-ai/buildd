/**
 * The kill-switch hand-off slot (docs/specs/workflow-state-kernel.md §14,
 * "Switch-off hands live deliveries to legacy"). Contract only, no runtime
 * imports: core (seam.ts) calls the slot, the reviews module implements it
 * (review-handoff.ts), the composition root wires it (`LEGACY_FIRST_REVIEW`
 * in apps/web/src/modules.ts).
 *
 * A delivery is opened at the exact point legacy would file a PR's first
 * review, and the kernel's first round is queued only when the owner attempt
 * ends. A delivery the kill switch releases before that has had no review
 * from either authority, and legacy files its first review only at PR open.
 * The slot is legacy's first review, filed late: the kernel had already
 * decided the PR needs one (or, with a pre-flight finding, a person).
 */
export interface LegacyFirstReviewInput {
  workspaceId: string;
  deliveryId: string;
  ownerTaskId: string;
  repoFullName: string;
  prNumber: number;
  installationId: number;
  /** The PR's live head and base, read by the caller now (R2). */
  headSha: string;
  baseRef: string | null;
  htmlUrl: string;
  /** The pre-flight finding the kernel recorded at open, if any: legacy answers it with a person, not a reviewer. */
  policyEvidence: { headSha: string; outcome: string; reason: string } | null;
}

export interface LegacyFirstReviewResult {
  /** `review_queued`, `reviewer_exists`, `human_review_required`, or why nothing was filed. */
  outcome: string;
}

export type LegacyFirstReview = (input: LegacyFirstReviewInput) => Promise<LegacyFirstReviewResult>;

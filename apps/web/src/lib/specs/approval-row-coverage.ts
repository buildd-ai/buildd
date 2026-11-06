import { explanationCoverage } from '@buildd/spec-contract/explanation';
import type { AwaitingApprovalRow } from './approval-inbox';
import { revisionReview } from './revision-changes';

/**
 * Explanation coverage for one inbox row (Living Spec b7fc9316 R-30): the
 * change list from the approved revision (the empty text when nothing is
 * approved) to the head, checked against the head's own explanation. A
 * revision stacked in between has no row and no coverage of its own; whatever
 * it changed is part of the one change list, so the head's explanation has to
 * cover it. Null when the change list cannot be read.
 */
export async function rowCoverage(r: Pick<AwaitingApprovalRow, 'specId' | 'bodyArtifactId' | 'approvedRevision' | 'headRevision' | 'explanation'>): Promise<string | null> {
  const review = await revisionReview({ id: r.specId, bodyArtifactId: r.bodyArtifactId }, r.approvedRevision ?? 0, r.headRevision).catch(() => null);
  if (!review) return null;
  return explanationCoverage(r.explanation, review.lines, review.otherText).line;
}

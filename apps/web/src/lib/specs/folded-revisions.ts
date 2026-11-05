/**
 * Stacked unapproved revisions fold under the newest (Living Spec b7fc9316
 * R-30, R-39). A spec has one inbox row, diffed from the approved revision to
 * the head; the revisions between the two are not rows, and are listed on the
 * row. Approve stays pinned to the head and its content hash (R-3).
 */
export function foldedRevisions(approvedRevision: number | null, headRevision: number): number[] {
  const out: number[] = [];
  for (let n = (approvedRevision ?? 0) + 1; n < headRevision; n++) out.push(n);
  return out;
}

/** "Folds revisions 3, 4 and 5"; null when nothing folded. */
export function foldedLine(folded: readonly number[]): string | null {
  if (!folded.length) return null;
  if (folded.length === 1) return `Folds revision ${folded[0]}`;
  return `Folds revisions ${folded.slice(0, -1).join(', ')} and ${folded[folded.length - 1]}`;
}

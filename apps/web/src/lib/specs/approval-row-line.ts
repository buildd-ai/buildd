/** The row's revision line (Living Spec b7fc9316 R-30): pure, so the client Review all component can use it. */
export function rowRevisionLine(r: { headRevision: number; approvedRevision: number | null; revisionsCovered: number }): string {
  if (r.approvedRevision == null) return `revision ${r.headRevision}, first approval`;
  const n = r.revisionsCovered;
  return `revision ${r.headRevision} replaces ${r.approvedRevision}${n > 1 ? `, covering ${n} revisions` : ''}`;
}

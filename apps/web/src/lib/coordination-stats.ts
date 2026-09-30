import type { ManifestCoverageCounts } from '@buildd/shared';
export function manifestCounts(rows: Array<{ total: number; concrete: number; advisory: number; none: number }>): ManifestCoverageCounts {
  const counts = rows.reduce((sum, row) => ({
    total: sum.total + Number(row.total), concrete: sum.concrete + Number(row.concrete),
    advisory: sum.advisory + Number(row.advisory), none: sum.none + Number(row.none),
  }), { total: 0, concrete: 0, advisory: 0, none: 0 });
  return { ...counts, concreteShare: counts.total ? counts.concrete / counts.total : null };
}

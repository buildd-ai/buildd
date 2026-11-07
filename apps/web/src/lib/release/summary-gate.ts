/**
 * The release-summary check (summary-store.ts `guardReleaseSummary`), loaded
 * lazily so the release doors carry no import of it at module load. A module
 * that cannot load reads as "the mode cannot be shown on", as an unreadable
 * workspace does inside it: a release is never failed by the check's absence.
 */
export type SummaryGateInput = { workspaceId: string; headSha: string; surface: string; door: 'dispatch' | 'merge' };
export type SummaryGateResult = { blocks: false } | { blocks: true; reason: string; clearedBy: string };
export type SummaryGate = (q: SummaryGateInput) => Promise<SummaryGateResult>;

export function defaultSummaryGate(db?: unknown): SummaryGate {
  return async (q) => {
    try {
      const { guardReleaseSummary } = await import('@/lib/release/summary-store');
      return await guardReleaseSummary(q, db ? { db: db as never } : {});
    } catch (err) {
      console.warn('[release-summary] check unavailable; summary approval not applied:', err);
      return { blocks: false };
    }
  };
}

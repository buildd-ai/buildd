import PrCard, { type PrOutcome } from '@/components/task/PrCard';
import type { OpenAttemptInfo } from '@/lib/explain';
import type { PrDisplayState } from '@/lib/pr-presentation';

export type StoredPrFacts = {
  prUrl: string;
  prNumber: number;
  prLifecycleStatus?: string | null;
  /** The delivery's PR state when the kernel owns the PR (§17.5); wins over the column. */
  prState?: PrDisplayState | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
  /** Task page outcome view (stored-state lineage); enriched here with check runs per commit. */
  outcome?: PrOutcome | null;
  /** The canonical open-fix-attempt fact (lib/explain.ts's loadOpenAttempt) — already live, never re-derived here. */
  openAttempt?: OpenAttemptInfo | null;
  /** The page's header already offers the PR's one action. */
  hideAction?: boolean;
  /** The status row already names and links this PR (PrCardProps.statedAbove). */
  statedAbove?: boolean;
};

/**
 * The PR card as it can be rendered from stored state alone — lifecycle, diff
 * size, the link. The task page uses it as the Suspense fallback for
 * `<PrDetailsCard />`, so the card paints complete and in place on first paint
 * and only the CI/review rows arrive later; the mission task sheet renders it
 * as its PR card. Both decide its facts with `taskPrFacts` (lib/task-sections).
 */
export function StoredPrCard(facts: StoredPrFacts) {
  return <PrCard {...facts} ciChecks={null} reviews={null} mergeable={null} mergeableState={null} />;
}

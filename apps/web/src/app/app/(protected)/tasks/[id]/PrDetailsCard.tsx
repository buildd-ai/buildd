import { after } from 'next/server';
import PrCard from '@/components/task/PrCard';
import { StoredPrCard, type StoredPrFacts } from '@/components/task/StoredPrCard';
import { prDetailsKey, readPrDetails, refreshPrDetails, sameRef, type PrDetails } from '@/lib/pr-details-cache';

export { StoredPrCard, type StoredPrFacts };

/** The stored facts with GitHub's cached view applied: CI, reviews, mergeability, runs per commit. */
export function withPrDetails(facts: StoredPrFacts, details: PrDetails) {
  return {
    ...facts,
    ciChecks: details.ciChecks,
    reviews: details.reviews,
    mergeable: details.mergeable,
    mergeableState: details.mergeableState,
    outcome: facts.outcome ? {
      ...facts.outcome,
      commits: facts.outcome.commits.map(c => {
        const runs = sameRef(c.ref, details.headSha)
          ? (details.ciChecks?.runs.length ? details.ciChecks.runs : null)
          : (c.ref ? details.runsByRef[c.ref] ?? null : null);
        return runs ? { ...c, runs } : c;
      }),
    } : facts.outcome,
  };
}

/**
 * The PR card enriched with GitHub's view — CI check runs, review states,
 * mergeability (AC-4) — as last cached for this PR head (lib/pr-details-cache.ts).
 *
 * Rendering never calls GitHub: it reads the cached answer and, when that is
 * missing or old, refreshes it after the response, so an open page's live
 * refreshes do not each make GitHub calls. With nothing cached yet the card
 * is the stored one, and the next render after the refresh carries the
 * details. Non-fatal by construction: every failure path is `StoredPrCard`.
 */
export default async function PrDetailsCard({
  workspaceId,
  headSha,
  ...facts
}: StoredPrFacts & { workspaceId: string; /** The PR head the page knows: the cache key. */ headSha?: string | null }) {
  try {
    const key = prDetailsKey(workspaceId, facts.prNumber, headSha);
    const { details, fresh } = await readPrDetails(key);
    if (!fresh) {
      const otherRefs = (facts.outcome?.commits ?? []).map(c => c.ref).filter((r): r is string => !!r);
      try {
        after(() => refreshPrDetails({ key, workspaceId, prNumber: facts.prNumber, otherRefs }));
      } catch {
        // Outside a request: the next render refreshes it.
      }
    }
    if (!details) return <StoredPrCard {...facts} />;
    return <PrCard {...withPrDetails(facts, details)} />;
  } catch {
    // Non-fatal — CI/review details are supplementary; merge state is in the DB.
    return <StoredPrCard {...facts} />;
  }
}

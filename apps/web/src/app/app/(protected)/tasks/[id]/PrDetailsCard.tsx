import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import PrCard, { type CiCheckRun } from '@/components/task/PrCard';
import { StoredPrCard, type StoredPrFacts } from '@/components/task/StoredPrCard';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export { StoredPrCard, type StoredPrFacts };

const toRun = (c: any): CiCheckRun => ({
  name: c.name,
  conclusion: c.conclusion ?? null,
  status: c.status,
  detailsUrl: c.details_url ?? c.html_url ?? null,
});

const sameRef = (a: string | undefined, b: string | undefined) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * The PR card enriched with GitHub's live view — CI check runs, review states,
 * mergeability (AC-4).
 *
 * This lives behind a Suspense boundary rather than inline in the page because
 * it is up to three sequential GitHub REST calls (the PR, its check runs, its
 * reviews) plus a workspace/installation read, and GitHub API latency from a
 * serverless function has no ceiling. Awaited on the critical path it was
 * frequently the single largest term in the render — and unlike the database
 * round trips on this page, it does not shrink from running in-region.
 *
 * Non-fatal by construction: merge state is already in the database and shown
 * by the fallback, so every failure path here degrades to `StoredPrCard`
 * instead of taking the page down.
 */
export default async function PrDetailsCard({
  workspaceId,
  ...facts
}: StoredPrFacts & { workspaceId: string }) {
  try {
    const wsWithInstall = await db.query.workspaces.findFirst({
      where: sqlWhere(eq(workspaces.id, workspaceId)),
      with: {
        githubInstallation: { columns: { installationId: true } },
        githubRepo: { columns: { fullName: true } },
      },
      columns: {},
    });
    const installId = wsWithInstall?.githubInstallation?.installationId;
    const repoFullName = wsWithInstall?.githubRepo?.fullName;
    if (!installId || !repoFullName) return <StoredPrCard {...facts} />;

    const pr = await githubApi(installId, `/repos/${repoFullName}/pulls/${facts.prNumber}`);
    const headSha = pr.head?.sha as string | undefined;
    // Earlier attempts' heads (a CI retry's failed commit) get their own check
    // runs, so "Checks by commit" shows what failed, not only what passed.
    const otherRefs = [...new Set((facts.outcome?.commits ?? [])
      .map(c => c.ref)
      .filter((r): r is string => !!r && !sameRef(r, headSha)))];
    const [checksResult, reviewsResult, ...otherResults] = await Promise.allSettled([
      headSha
        ? githubApi(installId, `/repos/${repoFullName}/commits/${headSha}/check-runs?per_page=100`)
        : Promise.resolve(null),
      githubApi(installId, `/repos/${repoFullName}/pulls/${facts.prNumber}/reviews`),
      ...otherRefs.map(ref => githubApi(installId, `/repos/${repoFullName}/commits/${ref}/check-runs?per_page=100`)),
    ]);
    const runsByRef = new Map<string, CiCheckRun[]>();
    otherRefs.forEach((ref, i) => {
      const r = otherResults[i];
      const list = r?.status === 'fulfilled' && Array.isArray((r.value as any)?.check_runs) ? (r.value as any).check_runs : null;
      if (list) runsByRef.set(ref, list.map(toRun));
    });
    const checksData = checksResult.status === 'fulfilled' ? checksResult.value : null;
    const reviewsData = reviewsResult.status === 'fulfilled' ? reviewsResult.value : null;
    const checkRuns: any[] = Array.isArray(checksData?.check_runs) ? checksData.check_runs : [];
    const isTerminal = (c: any) => c.status === 'completed';
    const isPassing = (c: any) => isTerminal(c) && (c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral');
    const isFailing = (c: any) => isTerminal(c) && (c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'cancelled' || c.conclusion === 'action_required');
    const reviewList: any[] = Array.isArray(reviewsData) ? reviewsData : [];
    const ACTIONABLE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'PENDING']);
    const latestByUser = new Map<string, string>();
    for (const r of reviewList) {
      if (r.user?.login && ACTIONABLE.has(r.state)) latestByUser.set(r.user.login, r.state);
    }
    const reviewStates = [...latestByUser.values()];

    return (
      <PrCard
        {...facts}
        ciChecks={checkRuns.length > 0 ? {
          total: checkRuns.length,
          passed: checkRuns.filter(isPassing).length,
          failed: checkRuns.filter(isFailing).length,
          pending: checkRuns.filter((c: any) => !isTerminal(c)).length,
          runs: checkRuns.map(toRun),
        } : null}
        reviews={{
          approved: reviewStates.filter(s => s === 'APPROVED').length,
          changesRequested: reviewStates.filter(s => s === 'CHANGES_REQUESTED').length,
          pending: reviewStates.filter(s => s === 'PENDING').length,
        }}
        mergeable={typeof pr.mergeable === 'boolean' ? pr.mergeable : null}
        mergeableState={typeof pr.mergeable_state === 'string' ? pr.mergeable_state : null}
        outcome={facts.outcome ? {
          ...facts.outcome,
          commits: facts.outcome.commits.map(c => {
            const runs = sameRef(c.ref, headSha)
              ? (checkRuns.length ? checkRuns.map(toRun) : null)
              : (c.ref ? runsByRef.get(c.ref) ?? null : null);
            return runs ? { ...c, runs } : c;
          }),
        } : facts.outcome}
      />
    );
  } catch {
    // Non-fatal — CI/review details are supplementary; merge state is in the DB.
    return <StoredPrCard {...facts} />;
  }
}

/**
 * The GitHub half of the task page's PR card (CI check runs, review states,
 * mergeability), cached per PR head (spec 3ef37387 R-14, R-15).
 *
 * A render reads the cached answer and never GitHub. When the answer is
 * missing or old, the render schedules `refreshPrDetails` after its response;
 * the refresh claims the row first (an expiry pushed `REFRESH_LEASE_MS`
 * ahead), so a burst of renders (every Pusher refresh of an open page) makes
 * one set of GitHub calls, not one per render. The key carries the head SHA
 * the page knows, so a new push reads as missing at once.
 *
 * Stored in `system_cache`, as the release baseline's prod-branch head is.
 */
import { db } from '@buildd/core/db';
import { systemCache, workspaces } from '@buildd/core/db/schema';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { githubApi } from '@/lib/github';
import { latestRunPerName } from '@/lib/ci-verdict';
import type { CiCheckRun } from '@/components/task/PrCard';
import { githubReviewCounts } from '@buildd/shared';

export interface PrDetails {
  /** The head GitHub reported. */
  headSha: string | null;
  ciChecks: { total: number; passed: number; failed: number; pending: number; runs: CiCheckRun[] } | null;
  /** `commented` is absent on an entry cached before it was counted. */
  reviews: { approved: number; changesRequested: number; pending: number; commented?: number };
  mergeable: boolean | null;
  mergeableState: string | null;
  /** Check runs of earlier attempt heads (a CI retry's failed commit), by ref. */
  runsByRef: Record<string, CiCheckRun[]>;
}

/** An answer with CI still running, or mergeability not computed yet, is refreshed sooner. */
export const PR_DETAILS_PENDING_MS = 2 * 60_000;
export const PR_DETAILS_SETTLED_MS = 15 * 60_000;
/** How long a claimed refresh holds the row before another render may try. */
export const REFRESH_LEASE_MS = 60_000;

export const prDetailsKey = (workspaceId: string, prNumber: number, headSha: string | null | undefined) =>
  `pr-details:v1:${workspaceId}:${prNumber}:${headSha || 'unknown'}`;

export function prDetailsTtlMs(d: PrDetails): number {
  return (d.ciChecks?.pending ?? 0) > 0 || d.mergeable == null ? PR_DETAILS_PENDING_MS : PR_DETAILS_SETTLED_MS;
}

const toRun = (c: any): CiCheckRun => ({
  name: c.name,
  conclusion: c.conclusion ?? null,
  status: c.status,
  detailsUrl: c.details_url ?? c.html_url ?? null,
});

export const sameRef = (a: string | undefined | null, b: string | undefined | null) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * GitHub's view of one PR: up to three REST calls (the PR, its head's check
 * runs, its reviews) plus one per earlier attempt head. Null when the
 * workspace has no installation or repo. Throws on a GitHub failure.
 */
export async function fetchPrDetails(workspaceId: string, prNumber: number, otherRefs: readonly string[]): Promise<PrDetails | null> {
  const ws = await db.query.workspaces.findFirst({
    where: sqlWhere(eq(workspaces.id, workspaceId)),
    with: {
      githubInstallation: { columns: { installationId: true } },
      githubRepo: { columns: { fullName: true } },
    },
    columns: {},
  });
  const installId = ws?.githubInstallation?.installationId;
  const repoFullName = ws?.githubRepo?.fullName;
  if (!installId || !repoFullName) return null;

  const pr = await githubApi(installId, `/repos/${repoFullName}/pulls/${prNumber}`);
  const headSha = (pr?.head?.sha as string | undefined) ?? null;
  const refs = [...new Set(otherRefs.filter(r => !!r && !sameRef(r, headSha)))];
  const [checksResult, reviewsResult, ...otherResults] = await Promise.allSettled([
    headSha ? githubApi(installId, `/repos/${repoFullName}/commits/${headSha}/check-runs?per_page=100`) : Promise.resolve(null),
    githubApi(installId, `/repos/${repoFullName}/pulls/${prNumber}/reviews`),
    ...refs.map(ref => githubApi(installId, `/repos/${repoFullName}/commits/${ref}/check-runs?per_page=100`)),
  ]);
  const runsByRef: Record<string, CiCheckRun[]> = {};
  refs.forEach((ref, i) => {
    const r = otherResults[i];
    const list = r?.status === 'fulfilled' && Array.isArray((r.value as any)?.check_runs) ? (r.value as any).check_runs : null;
    if (list) runsByRef[ref] = latestRunPerName(list).map(toRun);
  });
  const checksData = checksResult.status === 'fulfilled' ? checksResult.value : null;
  const reviewsData = reviewsResult.status === 'fulfilled' ? reviewsResult.value : null;
  // A run its re-run replaced on the same commit (a re-triggered gate) no longer speaks for it: the
  // newest run per check name does, as GitHub's merge box and the landing door read it.
  const checkRuns: any[] = Array.isArray(checksData?.check_runs) ? latestRunPerName(checksData.check_runs) : [];
  const isTerminal = (c: any) => c.status === 'completed';
  const isPassing = (c: any) => isTerminal(c) && (c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral');
  const isFailing = (c: any) => isTerminal(c) && (c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'cancelled' || c.conclusion === 'action_required');
  const reviewList: any[] = Array.isArray(reviewsData) ? reviewsData : [];
  return {
    headSha,
    ciChecks: checkRuns.length > 0 ? {
      total: checkRuns.length,
      passed: checkRuns.filter(isPassing).length,
      failed: checkRuns.filter(isFailing).length,
      pending: checkRuns.filter((c: any) => !isTerminal(c)).length,
      runs: checkRuns.map(toRun),
    } : null,
    // One per reviewer, with COMMENTED shown beside buildd's verdict (spec r7 §7, AC-24).
    reviews: githubReviewCounts(reviewList),
    mergeable: typeof pr?.mergeable === 'boolean' ? pr.mergeable : null,
    mergeableState: typeof pr?.mergeable_state === 'string' ? pr.mergeable_state : null,
    runsByRef,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The answer stored in a cache row's jsonb `value`, or null: a claim's
 * placeholder (`{ details: null }`) and any row not in `PrDetails` shape read
 * as no answer, so the card refreshes rather than rendering a malformed one.
 */
export function prDetailsOf(value: unknown): PrDetails | null {
  if (!isObject(value)) return null;
  const d = (value as { details?: unknown }).details;
  if (!isObject(d) || !isObject(d.reviews) || !isObject(d.runsByRef)) return null;
  if (d.ciChecks !== null && !isObject(d.ciChecks)) return null;
  return d as unknown as PrDetails;
}

/** The cached answer for `key` and whether it is still fresh. Never throws, never calls GitHub. */
export async function readPrDetails(key: string, now: number = Date.now()): Promise<{ details: PrDetails | null; fresh: boolean }> {
  try {
    const [row] = await db.select({ value: systemCache.value, expiresAt: systemCache.expiresAt })
      .from(systemCache).where(eq(systemCache.key, key)).limit(1);
    if (!row) return { details: null, fresh: false };
    return { details: prDetailsOf(row.value), fresh: !!row.expiresAt && row.expiresAt.getTime() > now };
  } catch {
    return { details: null, fresh: false };
  }
}

/**
 * Claim the refresh of `key`: true when this caller may call GitHub. An
 * existing row is claimed by pushing its expiry a lease ahead only while it
 * is expired; a missing row by inserting a placeholder. Either is one atomic
 * statement (neon-http has no transactions).
 */
async function claimRefresh(key: string, now: number): Promise<boolean> {
  const lease = new Date(now + REFRESH_LEASE_MS);
  const claimed = await db.update(systemCache).set({ expiresAt: lease })
    .where(and(eq(systemCache.key, key), or(isNull(systemCache.expiresAt), lt(systemCache.expiresAt, new Date(now)))))
    .returning({ key: systemCache.key });
  if (claimed.length > 0) return true;
  const inserted = await db.insert(systemCache).values({ key, value: { details: null }, updatedAt: new Date(now), expiresAt: lease })
    .onConflictDoNothing().returning({ key: systemCache.key });
  return inserted.length > 0;
}

/** Ask GitHub for the PR's details and store them under `key`. Best-effort; one caller per lease. */
export async function refreshPrDetails(input: { key: string; workspaceId: string; prNumber: number; otherRefs: readonly string[] }, now: number = Date.now()): Promise<void> {
  try {
    if (!(await claimRefresh(input.key, now))) return;
    const details = await fetchPrDetails(input.workspaceId, input.prNumber, input.otherRefs);
    // No installation or repo: nothing to ask, and nothing to ask again soon.
    const expiresAt = new Date(Date.now() + (details ? prDetailsTtlMs(details) : PR_DETAILS_SETTLED_MS));
    await db.update(systemCache).set({ value: { details }, updatedAt: new Date(), expiresAt }).where(eq(systemCache.key, input.key));
  } catch (err) {
    // The lease lapses on its own; the next render past it tries again.
    console.warn('[pr-details] refresh failed:', err instanceof Error ? err.message : err);
  }
}

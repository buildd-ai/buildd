// The ONE shared resolver for gated-release queue baselines. Both the
// missions page (mission-card footer) and the readiness route (Home widget)
// call this so they cannot disagree about where the queue-depth cutoff is.
//
// Delegates the pure ladder logic to @buildd/core/release-baseline; this file
// is only the I/O: fetch this workspace's release rows, and — only when none
// exist — resolve the prod-branch HEAD via a one-time GitHub call (rung 4).
// That call stops firing for a workspace as soon as its first release row
// exists (rungs 1-3 short-circuit before it). A page render never makes it
// (spec 3ef37387 R-12): `{ render: true }` reads the last answer from
// system_cache and refreshes it after the response when it is missing or old.
import { db } from '@buildd/core/db';
import { releases, systemCache } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { after } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import {
  resolveReleaseBaseline,
  resolveLatestCiReading,
  type ReleaseBaseline,
  type CiStateReading,
} from '@buildd/core/release-baseline';
import { resolveReleaseTarget } from '@/lib/release/target';
import { githubApi, isGitHubAppConfigured } from '@/lib/github';

export type { ReleaseBaseline, ReleaseBaselineSource, CiStateReading } from '@buildd/core/release-baseline';

export interface GatedReleaseState {
  baseline: ReleaseBaseline;
  ciState: CiStateReading;
  latestReleaseId: string | null;
  /** Most recent release row's commits-ahead snapshot — sanity-check input only, never a live count. */
  commitsAheadAtDispatch: number | null;
}

async function fetchReleaseCandidates(workspaceId: string) {
  return db
    .select({
      id: releases.id,
      state: releases.state,
      ciStateAtDispatch: releases.ciStateAtDispatch,
      commitsAheadAtDispatch: releases.commitsAheadAtDispatch,
      healthyAt: sql<string | null>`healthy_at::text`,
      deployedAt: sql<string | null>`deployed_at::text`,
      dispatchedAt: sql<string | null>`dispatched_at::text`,
      createdAt: sql<string>`created_at::text`,
    })
    .from(releases)
    .where(eq(releases.workspaceId, workspaceId));
}

export async function resolveGatedReleaseBaseline(
  workspaceId: string,
  opts: { render?: boolean } = {},
): Promise<ReleaseBaseline & { latestReleaseId: string | null }> {
  const rows = await fetchReleaseCandidates(workspaceId);

  if (rows.length > 0) {
    const latest = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return { ...resolveReleaseBaseline(rows, null), latestReleaseId: latest?.id ?? null };
  }

  const prodHeadAsOf = opts.render ? await prodHeadForRender(workspaceId) : await resolveProdBranchHeadAsOf(workspaceId);
  return { ...resolveReleaseBaseline([], prodHeadAsOf), latestReleaseId: null };
}

/** How long a cached prod-branch head is used before a render refreshes it (after its response). */
export const PROD_HEAD_CACHE_MS = 60 * 60_000;
const prodHeadKey = (workspaceId: string) => `release-baseline:prod-head:v1:${workspaceId}`;

/** Rung 4 for a page: the cached answer, refreshed after the response when missing or old. Never GitHub. */
async function prodHeadForRender(workspaceId: string): Promise<string | null> {
  let row: { value: unknown; expiresAt: Date | null } | undefined;
  try {
    row = await db.query.systemCache.findFirst({
      where: sqlWhere(eq(systemCache.key, prodHeadKey(workspaceId))),
      columns: { value: true, expiresAt: true },
    });
  } catch {
    row = undefined;
  }
  const fresh = !!row && (!row.expiresAt || new Date(row.expiresAt).getTime() > Date.now());
  if (!fresh) {
    try {
      after(() => refreshProdBranchHead(workspaceId));
    } catch {
      // Outside a request (a script): the next render refreshes it.
    }
  }
  const asOf = (row?.value as { asOf?: unknown } | null)?.asOf;
  return typeof asOf === 'string' ? asOf : null;
}

/** Ask GitHub for the prod-branch head and store the answer for renders. Best-effort. */
export async function refreshProdBranchHead(workspaceId: string): Promise<void> {
  try {
    const asOf = await resolveProdBranchHeadAsOf(workspaceId);
    const value = { asOf };
    const updatedAt = new Date();
    const expiresAt = new Date(updatedAt.getTime() + PROD_HEAD_CACHE_MS);
    await db.insert(systemCache).values({ key: prodHeadKey(workspaceId), value, updatedAt, expiresAt })
      .onConflictDoUpdate({ target: systemCache.key, set: { value, updatedAt, expiresAt } });
  } catch (err) {
    console.warn('[release-baseline] prod-branch head refresh failed:', err);
  }
}

/**
 * The ONE shared resolver for baseline + CI reading together — used by the
 * readiness route and the Home page so they cannot drift into computing the
 * "most recent releases row" independently and disagreeing about which row
 * won or how its CI/failed state should be read.
 */
export async function resolveGatedReleaseState(workspaceId: string, now: Date = new Date()): Promise<GatedReleaseState> {
  const rows = await fetchReleaseCandidates(workspaceId);
  const latest = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const ciState = resolveLatestCiReading(rows, now.toISOString());
  const commitsAheadAtDispatch = latest?.commitsAheadAtDispatch ?? null;

  if (rows.length > 0) {
    return {
      baseline: resolveReleaseBaseline(rows, null),
      ciState,
      latestReleaseId: latest?.id ?? null,
      commitsAheadAtDispatch,
    };
  }

  const prodHeadAsOf = await resolveProdBranchHeadAsOf(workspaceId);
  return {
    baseline: resolveReleaseBaseline([], prodHeadAsOf),
    ciState,
    latestReleaseId: null,
    commitsAheadAtDispatch: null,
  };
}

// Rung 4: no release has ever been recorded for this workspace, so the only
// honest baseline is "whatever is currently on the prod branch." Best-effort —
// any failure (no GitHub App, no linked repo, API error) degrades to null,
// which the ladder turns into `source: 'none'` (structurally unavailable).
async function resolveProdBranchHeadAsOf(workspaceId: string): Promise<string | null> {
  if (!isGitHubAppConfigured()) return null;

  const targetResult = await resolveReleaseTarget({ workspaceId, scope: { internal: true } });
  if (!targetResult.ok) return null;
  const target = targetResult.target;
  const prodBranch = target.releaseConfig?.prodBranch ?? target.defaultBranch;

  try {
    const commit = await githubApi(
      target.installationId,
      `/repos/${target.owner}/${target.name}/commits/${encodeURIComponent(prodBranch)}`,
    );
    const date = commit?.commit?.committer?.date ?? commit?.commit?.author?.date;
    return typeof date === 'string' ? date : null;
  } catch {
    return null;
  }
}

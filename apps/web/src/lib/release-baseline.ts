// The ONE shared resolver for gated-release queue baselines. Both the
// missions page (mission-card footer) and the readiness route (Home widget)
// call this so they cannot disagree about where the queue-depth cutoff is.
//
// Delegates the pure ladder logic to @buildd/core/release-baseline; this file
// is only the I/O: fetch this workspace's release rows, and — only when none
// exist — resolve the prod-branch HEAD via a one-time GitHub call (rung 4).
// That call stops firing for a workspace as soon as its first release row
// exists (rungs 1-3 short-circuit before it).
import { db } from '@buildd/core/db';
import { releases } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { resolveReleaseBaseline, type ReleaseBaseline } from '@buildd/core/release-baseline';
import { resolveReleaseTarget } from '@/lib/release/target';
import { githubApi, isGitHubAppConfigured } from '@/lib/github';

export type { ReleaseBaseline, ReleaseBaselineSource } from '@buildd/core/release-baseline';

export async function resolveGatedReleaseBaseline(workspaceId: string): Promise<ReleaseBaseline> {
  const rows = await db
    .select({
      state: releases.state,
      healthyAt: sql<string | null>`healthy_at::text`,
      deployedAt: sql<string | null>`deployed_at::text`,
      dispatchedAt: sql<string | null>`dispatched_at::text`,
      createdAt: sql<string>`created_at::text`,
    })
    .from(releases)
    .where(eq(releases.workspaceId, workspaceId));

  if (rows.length > 0) return resolveReleaseBaseline(rows, null);

  const prodHeadAsOf = await resolveProdBranchHeadAsOf(workspaceId);
  return resolveReleaseBaseline([], prodHeadAsOf);
}

// Rung 4: no release has ever been recorded for this workspace, so the only
// honest baseline is "whatever is currently on the prod branch." Best-effort —
// any failure (no GitHub App, no linked repo, API error) degrades to null,
// which the ladder turns into `source: 'none'` (structurally unavailable).
async function resolveProdBranchHeadAsOf(workspaceId: string): Promise<string | null> {
  if (!isGitHubAppConfigured()) return null;

  const targetResult = await resolveReleaseTarget({ workspaceId });
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

// Shared pieces of "a release PR merged into the prod branch — which release
// row did it ship?", used by the merge webhook (advanceGatedReleaseOnPrMerge
// in release-executor.ts) and by the stale-`pending_external` sweep in the
// release-health-check cron, which heals a row whose merge event was missed.

import { db } from '@buildd/core/db';
import { releases } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { verifyReleaseDeployment } from '@/lib/release-verification';

// Rows a gated release PR merge can still advance.
export const IN_FLIGHT_GATED_STATES = ['dispatched', 'pending_external'] as const;

// `scripts/release.sh` titles its PRs `Release vX.Y.Z` and `Hotfix vX.Y.Z`.
const RELEASE_TITLE_VERSION_RE = /^(?:Release|Hotfix) (v\d+\.\d+\.\d+)\b/;

export function versionFromReleasePrTitle(title: string | null | undefined): string | null {
  return title?.match(RELEASE_TITLE_VERSION_RE)?.[1] ?? null;
}

// The version a merge shipped: the release PR's title when it carries one,
// otherwise the root package.json at the merge commit. Null when neither
// yields a version — a row with no version is honest, a guessed one is not.
export async function resolveShippedVersion(params: {
  prTitle?: string | null;
  installationId?: number;
  repoFullName: string;
  mergeCommitSha?: string | null;
}): Promise<string | null> {
  const fromTitle = versionFromReleasePrTitle(params.prTitle);
  if (fromTitle) return fromTitle;
  if (!params.installationId || !params.mergeCommitSha) return null;
  try {
    const file = await githubApi(
      params.installationId,
      `/repos/${params.repoFullName}/contents/package.json?ref=${encodeURIComponent(params.mergeCommitSha)}`,
    );
    if (typeof file?.content !== 'string') return null;
    const pkg = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    return typeof pkg?.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version) ? `v${pkg.version}` : null;
  } catch {
    return null;
  }
}

// Does `descendant` contain `ancestor`? Exact equality needs no API call.
// Returns null when GitHub could not answer (no installation, API error) —
// callers treat that as "not shown to contain", never as a match.
export async function commitContains(
  installationId: number | undefined,
  repoFullName: string,
  ancestor: string,
  descendant: string,
): Promise<boolean | null> {
  if (ancestor === descendant) return true;
  if (!installationId) return null;
  try {
    const compare = await githubApi(
      installationId,
      `/repos/${repoFullName}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(descendant)}`,
    );
    const status = compare?.status as string | undefined;
    return status === 'ahead' || status === 'identical';
  } catch {
    return null;
  }
}

// Move one in-flight gated row to `deploying` for the merge that shipped it.
//
// The UPDATE is the compare-and-set: it only fires while the row is still in
// flight, so a concurrent webhook redelivery and the cron heal cannot both
// win. The merge commit becomes the row's head sha — it is what production
// actually runs, so the deploy-identity watch compares like with like, and a
// redelivered merge event then collides on (workspace_id, head_sha) instead
// of inserting a second row. Returns whether this call advanced the row.
//
// Side effect of the re-point: record.ts's non-forced dispatch idempotency
// check is keyed on (workspace, head sha), so once a row is re-pointed its
// original dispatch sha no longer looks recorded, and a non-forced
// re-dispatch of that sha is allowed again. That sha has already shipped, so
// a re-dispatch releases nothing new; dedup on the dispatch sha is not kept.
export async function advanceGatedRowForMerge(params: {
  releaseId: string;
  workspaceId: string;
  mergeCommitSha?: string | null;
  version: string | null;
}): Promise<boolean> {
  const { releaseId, workspaceId, mergeCommitSha, version } = params;
  const set: Record<string, unknown> = { state: 'deploying', deployedAt: new Date(), failureReason: null };
  if (version) set.version = version;
  const where = and(eq(releases.id, releaseId), inArray(releases.state, [...IN_FLIGHT_GATED_STATES]));

  let updated: { id: string } | undefined;
  try {
    [updated] = await db
      .update(releases)
      .set(mergeCommitSha ? { ...set, headSha: mergeCommitSha } : set)
      .where(where)
      .returning({ id: releases.id });
  } catch (err) {
    // Another row already owns the merge sha (unique on workspace + sha).
    // Advancing without re-pointing the sha is still correct: the watch's
    // ancestry check accepts a head sha that the deployed merge contains.
    if (!mergeCommitSha) throw err;
    console.warn(`[release] could not re-point release ${releaseId} at merge ${mergeCommitSha}:`, err);
    [updated] = await db.update(releases).set(set).where(where).returning({ id: releases.id });
  }
  if (!updated) return false;
  const advancedId = updated.id;

  await triggerEvent(channels.workspace(workspaceId), events.RELEASE_UPDATED, {
    releaseId: advancedId,
    state: 'deploying',
  }).catch(() => {});

  setTimeout(() => verifyReleaseDeployment(advancedId, db).catch(console.error), 0);
  return true;
}


export interface MergedReleasePr {
  number: number;
  title: string | null;
  mergeCommitSha: string;
  headSha: string;
}

// Find a release PR (head `headRef` → base `prodBranch`) merged after `since`
// whose head contains `sha`. This is the cron's way to tell "the release PR
// was never merged" (true) from "it merged and we missed the event" (the row
// shipped). Returns:
//   - the PR, when one is found;
//   - null, when GitHub answered and no merged PR contains the sha;
//   - 'unknown', when GitHub could not be asked or did not answer.
export async function findMergedReleasePrContaining(params: {
  installationId: number | null | undefined;
  repoFullName: string | null | undefined;
  prodBranch: string;
  headRef: string;
  sha: string;
  since: Date | null;
}): Promise<MergedReleasePr | null | 'unknown'> {
  const { installationId, repoFullName, prodBranch, headRef, sha, since } = params;
  if (!installationId || !repoFullName) return 'unknown';
  const owner = repoFullName.split('/')[0];

  let pulls: Array<{
    number: number;
    title?: string | null;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
    head?: { sha?: string };
  }>;
  try {
    pulls = (await githubApi(
      installationId,
      `/repos/${repoFullName}/pulls?state=closed&base=${encodeURIComponent(prodBranch)}` +
        `&head=${encodeURIComponent(`${owner}:${headRef}`)}&sort=updated&direction=desc&per_page=100`,
    )) ?? [];
  } catch {
    return 'unknown';
  }

  // Oldest merge first: the first release PR that contains the sha is the one
  // that shipped it.
  const merged = pulls
    .filter((p) => p.merged_at && p.merge_commit_sha && p.head?.sha)
    .filter((p) => !since || new Date(p.merged_at!).getTime() >= since.getTime())
    .sort((a, b) => new Date(a.merged_at!).getTime() - new Date(b.merged_at!).getTime());

  let sawUnknown = false;
  for (const pr of merged) {
    const contains = await commitContains(installationId, repoFullName, sha, pr.head!.sha!);
    if (contains === true) {
      return { number: pr.number, title: pr.title ?? null, mergeCommitSha: pr.merge_commit_sha!, headSha: pr.head!.sha! };
    }
    if (contains === null) sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : null;
}

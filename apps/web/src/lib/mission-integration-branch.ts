/**
 * Option A′ — mission integration branches.
 *
 * A mission that has opted in (`missions.integrationBranchEnabled`) keeps
 * per-task branches and per-task PRs exactly as it has always had them. The
 * single change is that a mission task's PR **base** is the mission's
 * integration branch (`missions.workingBranch`) instead of trunk. When the
 * mission's work is done the integration branch opens one PR into trunk, and
 * that mission PR is the single human gate — see `merge-policy.ts` for where
 * the tier applies.
 *
 * The pure predicates live in `@buildd/core/mission-integration` so that
 * merge-policy resolution and the completion criterion can ask the same
 * question without importing a GitHub client. This module is the IO half:
 * it makes the branch exist.
 */

import { db } from '@buildd/core/db';
import { githubRepos, missions, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { missionIntegrationBase } from '@buildd/core/mission-integration';

/** Extract the HTTP status out of the error `githubApi` throws on non-2xx. */
function githubErrorStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /GitHub API error: (\d{3})/.exec(msg);
  return m ? Number(m[1]) : null;
}

export type EnsureIntegrationBranchResult =
  | { ok: true; branch: string; created: boolean }
  | {
      ok: false;
      reason: 'not_opted_in' | 'no_working_branch' | 'no_repo' | 'api_error';
      detail?: string;
    };

/**
 * Make sure the mission's integration branch exists on the remote, cut from
 * trunk.
 *
 * This has to happen before any task PR can target it: GitHub rejects a pull
 * request whose base ref does not exist, so without this the first task of an
 * opted-in mission would fail to open a PR at all.
 *
 * Idempotent, and safe under concurrency — two callers racing to create the
 * same ref produce one 201 and one 422 "Reference already exists", and 422 is
 * treated as success rather than as an error, because it means exactly what we
 * wanted to be true.
 */
export async function ensureMissionIntegrationBranch(
  missionId: string,
): Promise<EnsureIntegrationBranchResult> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { workingBranch: true, integrationBranchEnabled: true, workspaceId: true },
  });
  if (!mission) return { ok: false, reason: 'no_repo', detail: 'mission not found' };
  if (!mission.integrationBranchEnabled) return { ok: false, reason: 'not_opted_in' };

  const branch = missionIntegrationBase(mission);
  if (!branch) return { ok: false, reason: 'no_working_branch' };

  const workspace = mission.workspaceId
    ? await db.query.workspaces.findFirst({
        where: eq(workspaces.id, mission.workspaceId),
        columns: { githubRepoId: true, githubInstallationId: true, gitConfig: true },
      })
    : null;
  if (!workspace?.githubRepoId || !workspace.githubInstallationId) {
    return { ok: false, reason: 'no_repo', detail: 'workspace not linked to a GitHub repo' };
  }

  const repo = await db.query.githubRepos.findFirst({
    where: eq(githubRepos.id, workspace.githubRepoId),
    columns: { fullName: true, defaultBranch: true },
    with: { installation: { columns: { installationId: true } } },
  });
  const installationId = repo?.installation?.installationId;
  if (!repo?.fullName || !installationId) {
    return { ok: false, reason: 'no_repo', detail: 'GitHub repo row not found' };
  }

  // Already there? Then we are done, and we say so — `created: false` is the
  // signal a caller needs to know it did not just reset anyone's branch.
  try {
    await githubApi(installationId, `/repos/${repo.fullName}/git/ref/heads/${branch}`);
    return { ok: true, branch, created: false };
  } catch (err) {
    if (githubErrorStatus(err) !== 404) {
      return { ok: false, reason: 'api_error', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  const trunk =
    workspace.gitConfig?.targetBranch ||
    workspace.gitConfig?.defaultBranch ||
    repo.defaultBranch ||
    'main';

  try {
    const trunkRef = await githubApi(
      installationId,
      `/repos/${repo.fullName}/git/ref/heads/${trunk}`,
    );
    const sha = trunkRef?.object?.sha;
    if (typeof sha !== 'string' || !sha) {
      return { ok: false, reason: 'api_error', detail: `could not resolve ${trunk} head` };
    }
    await githubApi(installationId, `/repos/${repo.fullName}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
    console.log(
      `[mission-integration-branch] created ${branch} from ${trunk}@${sha.slice(0, 7)} for mission ${missionId}`,
    );
    return { ok: true, branch, created: true };
  } catch (err) {
    // 422 = the ref already exists. A concurrent caller won the race; the
    // post-condition we care about holds either way.
    if (githubErrorStatus(err) === 422) return { ok: true, branch, created: false };
    return { ok: false, reason: 'api_error', detail: err instanceof Error ? err.message : String(err) };
  }
}

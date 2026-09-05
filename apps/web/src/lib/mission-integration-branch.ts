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

/**
 * Extract the HTTP status out of the error `githubApi` throws on non-2xx.
 *
 * The thrown message is `GitHub API error: ${status} ${body}` (see
 * `@/lib/github`), so the response body travels with the status and the
 * predicates below can read it.
 */
function githubErrorStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /GitHub API error: (\d{3})/.exec(msg);
  return m ? Number(m[1]) : null;
}

function githubErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Does this 422 mean "the ref you asked me to create is already there"?
 *
 * 422 is NOT a synonym for that. `POST /git/refs` also answers 422 for a sha
 * that does not exist (mistyped, or GC'd between the trunk lookup and the
 * create), for a ref name it refuses, and for generic validation failures. In
 * every one of those the branch was not created — so reporting success means
 * the caller posts no note, nothing points at the branch, and then every task
 * PR of the mission fails to open against a base ref that is absent. The only
 * 422 whose post-condition matches ours is the one that says so.
 */
function isReferenceAlreadyExists(err: unknown): boolean {
  return /reference already exists/i.test(githubErrorMessage(err));
}

/**
 * An unborn repository — no commits, so `refs/heads/*` cannot exist and cannot
 * be created. Its own reason because it is the one failure here that no retry
 * fixes: somebody has to push a first commit.
 */
function isEmptyRepository(err: unknown): boolean {
  return githubErrorStatus(err) === 409 && /repository is empty/i.test(githubErrorMessage(err));
}

export type EnsureIntegrationBranchResult =
  | { ok: true; branch: string; created: boolean }
  | {
      ok: false;
      reason: 'not_opted_in' | 'no_working_branch' | 'no_repo' | 'empty_repo' | 'api_error';
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
 * same ref produce one 201 and one 422 "Reference already exists", and THAT
 * 422 is treated as success rather than as an error, because it means exactly
 * what we wanted to be true. Every other 422 is a failure: see
 * `isReferenceAlreadyExists`.
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
    if (isEmptyRepository(err)) {
      return { ok: false, reason: 'empty_repo', detail: githubErrorMessage(err) };
    }
    if (githubErrorStatus(err) !== 404) {
      return { ok: false, reason: 'api_error', detail: githubErrorMessage(err) };
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
    // A concurrent caller won the race and the ref is already there: the
    // post-condition we care about holds, so this is success. Read the BODY,
    // not just the 422 — see isReferenceAlreadyExists for why a bare status
    // check turns three real failures into a silent success.
    if (githubErrorStatus(err) === 422 && isReferenceAlreadyExists(err)) {
      return { ok: true, branch, created: false };
    }
    if (isEmptyRepository(err)) {
      return { ok: false, reason: 'empty_repo', detail: githubErrorMessage(err) };
    }
    return { ok: false, reason: 'api_error', detail: githubErrorMessage(err) };
  }
}

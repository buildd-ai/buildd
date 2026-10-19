import { githubApi } from '@/lib/github';
import { encodeRef, isAncestor } from '@/lib/integration-refresh';
import type { MissionTarget } from './mission-outcome-fold';

type Api = (installationId: number, path: string, options?: RequestInit) => Promise<any>;

/**
 * The integrated target of a mission-branch mission, as GitHub reports it now.
 *
 * While the integration branch exists, its head. Once the mission PR has
 * merged into trunk the branch is usually deleted, and the integrated result
 * then lives on trunk: the target becomes any trunk commit that holds that
 * merge, the same shape a direct mission's target has. A verdict recorded on
 * the integration branch before the merge does not hold that commit, so it
 * reads stale and the mission is verified again on trunk (c5a2c67b R-4).
 * Anything that cannot be read is unknown, never a pass.
 */
export async function integrationTarget(
  repo: { installationId: number; fullName: string },
  branch: string,
  candidateHeads: readonly string[],
  api: Api = githubApi,
): Promise<MissionTarget> {
  try {
    const ref = await api(repo.installationId, `/repos/${repo.fullName}/git/ref/heads/${encodeRef(branch)}`);
    const sha = typeof ref?.object?.sha === 'string' ? ref.object.sha : null;
    if (sha) return { kind: 'integration', headSha: sha.toLowerCase(), branch };
  } catch {
    // Gone or unreadable: look for the merged mission PR below.
  }
  const unreadable: MissionTarget = { kind: 'unknown', reason: `the integration branch ${branch} could not be read` };
  const owner = repo.fullName.split('/')[0];
  let pulls: unknown;
  try {
    pulls = await api(repo.installationId, `/repos/${repo.fullName}/pulls?state=closed&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`);
  } catch {
    return unreadable;
  }
  const merged = Array.isArray(pulls)
    ? pulls.find((p) => p && typeof p.merged_at === 'string' && typeof p.merge_commit_sha === 'string')
    : undefined;
  if (!merged) return unreadable;
  const mergeSha = (merged.merge_commit_sha as string).toLowerCase();
  const validHeads = new Set<string>();
  for (const head of new Set(candidateHeads.map((h) => h.toLowerCase()))) {
    if ((await isAncestor(repo.installationId, repo.fullName, mergeSha, head, api)) === true) validHeads.add(head);
  }
  return { kind: 'direct', mergeShas: [mergeSha], validHeads };
}

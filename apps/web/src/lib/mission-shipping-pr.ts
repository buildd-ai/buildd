/**
 * Has a mission's one PR into trunk (its shipping PR) merged?
 *
 * `findMissionPrOwner(...).state === 'merged'` reads only `workers.mergedAt`,
 * which a lossy webhook can leave unset. A mission whose shipping PR merged
 * without it kept being refreshed, and kept filing conflict tasks for a branch
 * nothing would land again (docs/specs/mission-branch-refresh.md,
 * "Eligibility"). So three sources are read, cheapest first, stopping at the
 * first that says merged:
 *
 *  1. the owner worker row's `mergedAt`;
 *  2. the kernel delivery for that PR, in state MERGED (any authority: a merge
 *     recorded on a released delivery is still a merge);
 *  3. one live GitHub read of the PR (`merged: true`).
 *
 * Interim: the end state is the kernel owning delivery state outright
 * (docs/specs/workflow-kernel-library.md §6). Every read is best effort, and a
 * failed read counts as "not shown merged", never as merged.
 */
import { githubApi } from '@/lib/github';
import { findMissionPrOwner } from '@/lib/mission-pr';
import { deliveryPrStates } from '@/lib/workflow/delivery-view';

export interface MissionPrMerged {
  /** The shipping PR's number, when known. */
  prNumber: number | null;
  /** Which source showed the merge. */
  via: 'worker' | 'delivery' | 'github';
}

/** Where the shipping PR lives. Without it only the worker row is read. */
export interface MissionPrRepo {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
}

function prNumberOf(owner: { prNumber: number | null; prUrl: string | null }, repoFullName?: string): number | null {
  if (typeof owner.prNumber === 'number' && owner.prNumber > 0) return owner.prNumber;
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(owner.prUrl ?? '');
  if (!m) return null;
  // A URL naming another repo is not this mission's shipping PR in this repo.
  if (repoFullName && m[1]!.toLowerCase() !== repoFullName.toLowerCase()) return null;
  return Number(m[2]);
}

export async function missionShippingPrMerged(missionId: string, repo?: MissionPrRepo | null): Promise<MissionPrMerged | null> {
  const owner = await findMissionPrOwner(missionId);
  if (!owner) return null;
  const prNumber = prNumberOf(owner, repo?.repoFullName);
  if (owner.state === 'merged') return { prNumber, via: 'worker' };
  if (prNumber == null || !repo) return null;

  try {
    const states = await deliveryPrStates(repo.workspaceId, [prNumber]);
    if (states.some((d) => d.prNumber === prNumber && d.state === 'MERGED')) return { prNumber, via: 'delivery' };
  } catch { /* unreadable: fall through to GitHub */ }

  try {
    const pr = await githubApi(repo.installationId, `/repos/${repo.repoFullName}/pulls/${prNumber}`);
    if (pr?.merged === true) return { prNumber, via: 'github' };
  } catch { /* unreadable: not shown merged */ }
  return null;
}

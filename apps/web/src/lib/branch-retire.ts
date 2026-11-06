/**
 * Branch retirement: when may buildd delete a branch it pushed?
 *
 * GitHub's delete-branch-on-merge only removes the head of a PR that MERGES.
 * Everything else buildd creates stayed on the remote forever: the head of a
 * PR closed unmerged (superseded, `close_pr`, an abandoned retry), the branch a
 * reviewer, CI-retry or builder-after-ci task pushed and never opened a PR for,
 * a release candidate whose PR closed, a merged PR's branch that a later push
 * moved. This is the one decision every path asks (branch-retire-store.ts):
 * the PR close, the task's terminal transition, and the daily sweep that is the
 * floor for whatever escaped both.
 *
 * Pure: facts in, verdict out. The keep-rules come first and any of them wins.
 * Deletion is the only write, and only of a branch buildd itself created.
 */
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';

/** A PR-less branch with commits outside trunk waits this long after its last push. */
export const NO_PR_MIN_AGE_MS = 7 * 86_400_000;

/** Mission statuses after which nothing will build on its branch again. */
const ENDED_MISSION_STATUSES: ReadonlySet<string> = new Set(['completed', 'archived']);
const TERMINAL_TASKS: ReadonlySet<string> = new Set(TERMINAL_TASK_STATUSES);

/** Who made the branch, as buildd's own records say. Null: not a branch buildd created. */
export type BranchOwner =
  /** Every task whose worker checked this branch out (`workers.branch`, written only by the claim route). */
  | { kind: 'task'; taskStatuses: string[] }
  /** A mission integration branch, or one of its delivery rotations: the statuses of the missions it names. */
  | { kind: 'mission'; missionStatuses: string[] }
  /** A head the workspace's release config declares a candidate branch (`release/v*`). */
  | { kind: 'release_candidate' };

export interface EndedPr { number: number; merged: boolean; headSha: string; endedAt: Date | null }

export interface BranchFacts {
  branch: string;
  /** The branch's tip, or null when it no longer exists. */
  tipSha: string | null;
  tipCommittedAt: Date | null;
  isProtected: boolean;
  /** Trunk names for this repo: its default branch and the workspace's own (dev, main, ...). */
  trunkBranches: string[];
  openPrsAsHead: number[];
  /** Open PRs stacked on this branch. */
  openPrsAsBase: number[];
  /** PRs from this branch that merged or closed. */
  endedPrs: EndedPr[];
  /** Is the tip wholly contained in trunk? Null: not read. */
  tipInTrunk: boolean | null;
  owner: BranchOwner | null;
  /** A task that has not ended names this branch as its head or its base. */
  referencedByLiveTask: boolean;
}

export type KeepReason =
  | 'gone' | 'trunk' | 'protected' | 'not_buildd_branch' | 'open_pr' | 'open_pr_based_on_it'
  | 'referenced_by_live_task' | 'task_live' | 'task_unknown' | 'mission_live' | 'mission_unknown'
  | 'unshipped_commits_after_pr' | 'no_pr_young' | 'no_pr_not_task_branch'
  /** A GitHub read or the delete failed: kept, the next pass asks again. Set by the store, never by the decision. */
  | 'unreadable';

export type DeleteReason = 'pr_merged' | 'pr_closed_unmerged' | 'no_pr_contained' | 'no_pr_task_ended';

export type BranchVerdict = { action: 'keep'; reason: KeepReason } | { action: 'delete'; reason: DeleteReason };

const keep = (reason: KeepReason): BranchVerdict => ({ action: 'keep', reason });

export function decideBranchRetire(f: BranchFacts, now: Date): BranchVerdict {
  if (!f.tipSha) return keep('gone');
  if (f.branch === 'dev' || f.branch === 'main' || f.trunkBranches.includes(f.branch)) return keep('trunk');
  if (f.isProtected) return keep('protected');
  if (!f.owner) return keep('not_buildd_branch');
  if (f.openPrsAsHead.length > 0) return keep('open_pr');
  if (f.openPrsAsBase.length > 0) return keep('open_pr_based_on_it');
  if (f.referencedByLiveTask) return keep('referenced_by_live_task');

  if (f.owner.kind === 'task') {
    if (f.owner.taskStatuses.length === 0) return keep('task_unknown');
    if (f.owner.taskStatuses.some((s) => !TERMINAL_TASKS.has(s))) return keep('task_live');
  }
  if (f.owner.kind === 'mission') {
    // A ship PR can merge (and GitHub delete the branch) while the mission's tasks still need it:
    // a mission branch is never retired here before its mission ends.
    if (f.owner.missionStatuses.length === 0) return keep('mission_unknown');
    if (f.owner.missionStatuses.some((s) => !ENDED_MISSION_STATUSES.has(s))) return keep('mission_live');
  }

  if (f.endedPrs.length > 0) {
    // The branch must sit at a head a PR ended on (that PR keeps the commits and GitHub can restore
    // the branch), or be wholly in trunk. Anything else is work pushed after the PR that never shipped.
    const atEndedHead = f.endedPrs.some((p) => p.headSha === f.tipSha);
    if (!atEndedHead && f.tipInTrunk !== true) return keep('unshipped_commits_after_pr');
    return { action: 'delete', reason: f.endedPrs.some((p) => p.merged) ? 'pr_merged' : 'pr_closed_unmerged' };
  }

  // No PR ever came from it.
  if (f.tipInTrunk === true) return { action: 'delete', reason: 'no_pr_contained' };
  // Only a task's own scratch branch is aged out; a mission or release branch with no PR is never guessed dead.
  if (f.owner.kind !== 'task') return keep('no_pr_not_task_branch');
  if (!f.tipCommittedAt || now.getTime() - f.tipCommittedAt.getTime() < NO_PR_MIN_AGE_MS) return keep('no_pr_young');
  return { action: 'delete', reason: 'no_pr_task_ended' };
}

/** `mission/<slug>-<id8>` or a delivery rotation `mission/<slug>-<id8>-delivery-<n>`: the mission's id prefix. */
export function missionIdPrefixOf(branch: string): string | null {
  if (!branch.startsWith('mission/')) return null;
  return branch.match(/-([0-9a-f]{8})(?:-delivery-\d+)?$/)?.[1] ?? null;
}

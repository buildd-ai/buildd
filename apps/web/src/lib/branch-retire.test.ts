import { describe, it, expect } from 'bun:test';
import { decideBranchRetire, missionIdPrefixOf, NO_PR_MIN_AGE_MS, type BranchFacts } from './branch-retire';

const NOW = new Date('2026-11-06T12:00:00Z');
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function facts(over: Partial<BranchFacts> = {}): BranchFacts {
  return {
    branch: 'buildd/abcdef12-some-task',
    tipSha: 'tip',
    tipCommittedAt: ago(30 * DAY),
    isProtected: false,
    trunkBranches: ['dev', 'main'],
    openPrsAsHead: [],
    openPrsAsBase: [],
    endedPrs: [],
    tipInTrunk: null,
    owner: { kind: 'task', taskStatuses: ['completed'] },
    referencedByLiveTask: false,
    ...over,
  };
}

const ended = (merged: boolean, headSha = 'tip') => ({ number: 7, merged, headSha, endedAt: ago(DAY) });

describe('decideBranchRetire: what is deleted', () => {
  it('a merged PR whose branch still sits at the head that merged', () => {
    expect(decideBranchRetire(facts({ endedPrs: [ended(true)] }), NOW)).toEqual({ action: 'delete', reason: 'pr_merged' });
  });

  it('a PR closed without merging (superseded, close_pr, abandoned): the PR keeps its commits and GitHub can restore the branch', () => {
    expect(decideBranchRetire(facts({ endedPrs: [ended(false)] }), NOW)).toEqual({ action: 'delete', reason: 'pr_closed_unmerged' });
  });

  it('a branch that moved after its PR ended but is wholly in trunk', () => {
    expect(decideBranchRetire(facts({ endedPrs: [ended(true, 'older')], tipInTrunk: true }), NOW)).toEqual({ action: 'delete', reason: 'pr_merged' });
  });

  it('a PR-less branch of an ended task (reviewer, CI-retry, builder-after-ci) once it is old enough', () => {
    expect(decideBranchRetire(facts({ tipCommittedAt: ago(NO_PR_MIN_AGE_MS + 1) }), NOW)).toEqual({ action: 'delete', reason: 'no_pr_task_ended' });
  });

  it('a PR-less branch with nothing outside trunk goes at once, whatever its age', () => {
    expect(decideBranchRetire(facts({ tipCommittedAt: ago(1000), tipInTrunk: true }), NOW)).toEqual({ action: 'delete', reason: 'no_pr_contained' });
  });

  it('a finished release candidate', () => {
    expect(decideBranchRetire(facts({ branch: 'release/v1.2.3', owner: { kind: 'release_candidate' }, endedPrs: [ended(true)] }), NOW))
      .toEqual({ action: 'delete', reason: 'pr_merged' });
    expect(decideBranchRetire(facts({ branch: 'release/v1.2.4', owner: { kind: 'release_candidate' }, endedPrs: [ended(false)] }), NOW))
      .toEqual({ action: 'delete', reason: 'pr_closed_unmerged' });
  });

  it('a finished mission\'s branch whose PR ended', () => {
    expect(decideBranchRetire(facts({ branch: 'mission/x-12345678', owner: { kind: 'mission', missionStatuses: ['completed'] }, endedPrs: [ended(true)] }), NOW))
      .toEqual({ action: 'delete', reason: 'pr_merged' });
  });
});

describe('decideBranchRetire: the keep-rules', () => {
  const keep = (f: BranchFacts) => decideBranchRetire(f, NOW);

  it('a branch that is already gone is nothing to do', () => {
    expect(keep(facts({ tipSha: null }))).toEqual({ action: 'keep', reason: 'gone' });
  });

  it('trunk, by name, whatever else is true', () => {
    for (const b of ['dev', 'main']) {
      expect(keep(facts({ branch: b, endedPrs: [ended(true)] }))).toEqual({ action: 'keep', reason: 'trunk' });
    }
    expect(keep(facts({ branch: 'master', trunkBranches: ['master'], endedPrs: [ended(true)] }))).toEqual({ action: 'keep', reason: 'trunk' });
  });

  it('a protected branch', () => {
    expect(keep(facts({ isProtected: true, endedPrs: [ended(true)] }))).toEqual({ action: 'keep', reason: 'protected' });
  });

  it('a branch buildd did not create (a person\'s feat/ branch)', () => {
    expect(keep(facts({ branch: 'feat/x', owner: null, endedPrs: [ended(false)] }))).toEqual({ action: 'keep', reason: 'not_buildd_branch' });
  });

  it('any branch with an open PR, as head or as base', () => {
    expect(keep(facts({ openPrsAsHead: [1], endedPrs: [ended(false)] }))).toEqual({ action: 'keep', reason: 'open_pr' });
    expect(keep(facts({ openPrsAsBase: [2], endedPrs: [ended(true)] }))).toEqual({ action: 'keep', reason: 'open_pr_based_on_it' });
  });

  it('an open release candidate (its PR is open)', () => {
    expect(keep(facts({ branch: 'release/v1.2.3', owner: { kind: 'release_candidate' }, openPrsAsHead: [9] }))).toEqual({ action: 'keep', reason: 'open_pr' });
  });

  it('a release branch with no PR at all is never guessed dead', () => {
    expect(keep(facts({ branch: 'release/v1.2.3', owner: { kind: 'release_candidate' } }))).toEqual({ action: 'keep', reason: 'no_pr_not_task_branch' });
  });

  it('a branch of a task that is still pending, assigned or running', () => {
    for (const s of ['pending', 'assigned', 'in_progress', 'running']) {
      expect(keep(facts({ owner: { kind: 'task', taskStatuses: ['completed', s] }, endedPrs: [ended(false)] }))).toEqual({ action: 'keep', reason: 'task_live' });
    }
  });

  it('a task branch with no task found is kept (cannot prove it ended)', () => {
    expect(keep(facts({ owner: { kind: 'task', taskStatuses: [] }, endedPrs: [ended(false)] }))).toEqual({ action: 'keep', reason: 'task_unknown' });
  });

  it('a branch a live task stacks on or pushes to', () => {
    expect(keep(facts({ referencedByLiveTask: true, endedPrs: [ended(true)] }))).toEqual({ action: 'keep', reason: 'referenced_by_live_task' });
  });

  it('a mission branch whose mission is still open, even after its ship PR merged early', () => {
    for (const s of ['active', 'paused', 'budget_exhausted']) {
      expect(keep(facts({ branch: 'mission/x-12345678', owner: { kind: 'mission', missionStatuses: [s] }, endedPrs: [ended(true)] })))
        .toEqual({ action: 'keep', reason: 'mission_live' });
    }
  });

  it('a mission branch whose mission cannot be found', () => {
    expect(keep(facts({ branch: 'mission/x-12345678', owner: { kind: 'mission', missionStatuses: [] }, endedPrs: [ended(true)] })))
      .toEqual({ action: 'keep', reason: 'mission_unknown' });
  });

  it('commits pushed after the PR ended that are not in trunk', () => {
    expect(keep(facts({ endedPrs: [ended(true, 'older')], tipInTrunk: false }))).toEqual({ action: 'keep', reason: 'unshipped_commits_after_pr' });
    // Unread is not "contained".
    expect(keep(facts({ endedPrs: [ended(false, 'older')], tipInTrunk: null }))).toEqual({ action: 'keep', reason: 'unshipped_commits_after_pr' });
  });

  it('a PR-less task branch younger than the safe age, or with no tip date', () => {
    expect(keep(facts({ tipCommittedAt: ago(NO_PR_MIN_AGE_MS - 1000) }))).toEqual({ action: 'keep', reason: 'no_pr_young' });
    expect(keep(facts({ tipCommittedAt: null }))).toEqual({ action: 'keep', reason: 'no_pr_young' });
  });

  it('a PR-less mission branch of an ended mission with unshipped commits', () => {
    expect(keep(facts({ branch: 'mission/x-12345678', owner: { kind: 'mission', missionStatuses: ['completed'] }, tipInTrunk: false })))
      .toEqual({ action: 'keep', reason: 'no_pr_not_task_branch' });
  });
});

describe('missionIdPrefixOf', () => {
  it('reads the mission id prefix from an integration branch and its delivery rotations', () => {
    expect(missionIdPrefixOf('mission/build-staged-self-review-671a9f95')).toBe('671a9f95');
    expect(missionIdPrefixOf('mission/lighter-spec-review-75e972ee-delivery-2')).toBe('75e972ee');
    expect(missionIdPrefixOf('buildd/75e972ee-x')).toBeNull();
    expect(missionIdPrefixOf('mission/no-id')).toBeNull();
  });
});

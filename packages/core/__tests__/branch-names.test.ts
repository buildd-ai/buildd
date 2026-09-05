import { describe, it, expect } from 'bun:test';
import { generateTaskBranchName, sanitizeBranchTitle } from '../branch-names';

/**
 * This is the branch-naming contract itself: the claim route creates
 * `workers.branch` from it, and approve-plan predicts a dependency's branch
 * from it. The two used to hold separate copies of the chain and drifted —
 * these cases pin the precedence so a copy cannot come back.
 */

const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID8 = 'aaaaaaaa';

describe('sanitizeBranchTitle', () => {
  it('lowercases and collapses non-alphanumerics to a single dash', () => {
    expect(sanitizeBranchTitle('Fix  the  Thing!! (again)')).toBe('fix-the-thing-again-');
  });

  it('truncates to 30 characters', () => {
    expect(sanitizeBranchTitle('a'.repeat(50))).toHaveLength(30);
  });
});

describe('generateTaskBranchName', () => {
  it('defaults to buildd/<id8>-<slug>', () => {
    expect(generateTaskBranchName({ taskId: TASK_ID, title: 'Add schema migration' }))
      .toBe(`buildd/${ID8}-add-schema-migration`);
  });

  it('branchingStrategy=none drops the slug entirely', () => {
    expect(generateTaskBranchName({
      taskId: TASK_ID,
      title: 'Add schema migration',
      gitConfig: { branchingStrategy: 'none' },
    })).toBe(`task-${ID8}`);
  });

  it('applies a custom branchPrefix', () => {
    expect(generateTaskBranchName({
      taskId: TASK_ID,
      title: 'Add schema migration',
      gitConfig: { branchPrefix: 'agent/' },
    })).toBe(`agent/${ID8}-add-schema-migration`);
  });

  it('useBuildBranch outranks branchPrefix', () => {
    // The drift that made approve-plan predict a ref that never exists.
    expect(generateTaskBranchName({
      taskId: TASK_ID,
      title: 'Add schema migration',
      gitConfig: { branchPrefix: 'agent/', useBuildBranch: true },
    })).toBe(`buildd/${ID8}-add-schema-migration`);
  });

  it('branchingStrategy=none outranks useBuildBranch and branchPrefix', () => {
    expect(generateTaskBranchName({
      taskId: TASK_ID,
      title: 'Add schema migration',
      gitConfig: { branchingStrategy: 'none', branchPrefix: 'agent/', useBuildBranch: true },
    })).toBe(`task-${ID8}`);
  });

  it('a shared mission head branch wins over every gitConfig rule', () => {
    expect(generateTaskBranchName({
      taskId: TASK_ID,
      title: 'Add schema migration',
      gitConfig: { branchingStrategy: 'none', branchPrefix: 'agent/', useBuildBranch: true },
      sharedHeadBranch: 'mission/delivery-arc-1a2b3c4d',
    })).toBe('mission/delivery-arc-1a2b3c4d');
  });

  it('ignores an empty or non-string sharedHeadBranch', () => {
    const expected = `buildd/${ID8}-add-schema-migration`;
    expect(generateTaskBranchName({ taskId: TASK_ID, title: 'Add schema migration', sharedHeadBranch: '' })).toBe(expected);
    expect(generateTaskBranchName({ taskId: TASK_ID, title: 'Add schema migration', sharedHeadBranch: 42 })).toBe(expected);
    expect(generateTaskBranchName({ taskId: TASK_ID, title: 'Add schema migration', sharedHeadBranch: null })).toBe(expected);
  });
});

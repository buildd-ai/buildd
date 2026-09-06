import { describe, it, expect } from 'bun:test';
import { generateMissionBranchName, generateTaskBranchName, sanitizeBranchTitle } from '../branch-names';
import { MISSION_BRANCH_PREFIX } from '../mission-integration';

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

/**
 * `generateMissionBranchName` is the only definition of an Option A' mission's
 * working-branch name — `runMission` (apps/web/src/lib/mission-run.ts) and
 * mission creation (apps/web/src/app/api/missions/route.ts) both call it
 * rather than re-deriving the rule. These cases pin the existing convention
 * byte-for-byte so an existing mission's branch name round-trips unchanged.
 */
describe('generateMissionBranchName', () => {
  const MISSION_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
  const MISSION_ID8 = 'bbbbbbbb';

  it('lowercases, hyphenates, and appends the mission id8', () => {
    expect(generateMissionBranchName({ missionId: MISSION_ID, title: 'Ship the onboarding flow' }))
      .toBe(`${MISSION_BRANCH_PREFIX}ship-the-onboarding-flow-${MISSION_ID8}`);
  });

  it('truncates a title that overflows 40 characters mid-word', () => {
    const title = 'Migrate every legacy worker to the new claim route contract end to end';
    expect(generateMissionBranchName({ missionId: MISSION_ID, title }))
      .toBe(`${MISSION_BRANCH_PREFIX}migrate-every-legacy-worker-to-the-new-c-${MISSION_ID8}`);
  });

  it('falls back to "mission" when the title is all punctuation', () => {
    expect(generateMissionBranchName({ missionId: MISSION_ID, title: '!!! ??? ---' }))
      .toBe(`${MISSION_BRANCH_PREFIX}mission-${MISSION_ID8}`);
  });

  it('strips hyphens produced by punctuation at the edges', () => {
    expect(generateMissionBranchName({ missionId: MISSION_ID, title: '-- Ship it! --' }))
      .toBe(`${MISSION_BRANCH_PREFIX}ship-it-${MISSION_ID8}`);
  });

  it('uses only the first 8 characters of the mission id', () => {
    const name = generateMissionBranchName({ missionId: MISSION_ID, title: 'Anything' });
    expect(name).toBe(`${MISSION_BRANCH_PREFIX}anything-${MISSION_ID8}`);
    expect(name).not.toContain(MISSION_ID.slice(8));
  });
});

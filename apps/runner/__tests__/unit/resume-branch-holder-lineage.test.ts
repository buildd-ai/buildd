/**
 * Pure decision for M1 of docs/design/pr-merge-reliability.md: may a retry take
 * its resume branch away from the worktree that currently holds it?
 *
 * Only when the holder is a TERMINAL worker in the runner's own registry
 * (done/error — never waiting, stale or working) and belongs to the retry's
 * task lineage. Everything else keeps today's diversion.
 */
import { describe, test, expect } from 'bun:test';
import {
  classifyResumeBranchHolder,
  resolveReleaseHeldBranchMode,
  type LineageHolderRecord,
} from '../../src/worktree-utils';

const HOLDER = '/repo/.buildd-worktrees/buildd_aaaa1111-fix';

function registry(rec: Partial<LineageHolderRecord> & { id?: string }): Array<[string, LineageHolderRecord]> {
  const { id = 'w-prior', ...rest } = rec;
  return [[id, { worktreePath: HOLDER, status: 'done', taskId: 'task-A', ...rest }]];
}

const lineage = { taskId: 'task-B', parentTaskId: 'task-A' };

describe('classifyResumeBranchHolder', () => {
  test('done holder whose task is the retry parent is eligible', () => {
    expect(classifyResumeBranchHolder(registry({}), HOLDER, lineage, 'w-new'))
      .toEqual({ eligible: true, holderWorkerId: 'w-prior' });
  });

  test('error holder is eligible', () => {
    expect(classifyResumeBranchHolder(registry({ status: 'error' }), HOLDER, lineage, 'w-new').eligible).toBe(true);
  });

  test('holder on the SAME task (re-claimed task) is eligible', () => {
    expect(classifyResumeBranchHolder(registry({ taskId: 'task-B' }), HOLDER, lineage, 'w-new').eligible).toBe(true);
  });

  test('grand-parent attempt is eligible when the chain is visible in the registry', () => {
    const workers: Array<[string, LineageHolderRecord]> = [
      ['w-root', { worktreePath: HOLDER, status: 'done', taskId: 'task-root' }],
      ['w-mid', { worktreePath: '/elsewhere', status: 'done', taskId: 'task-A', parentTaskId: 'task-root' }],
    ];
    expect(classifyResumeBranchHolder(workers, HOLDER, lineage, 'w-new'))
      .toEqual({ eligible: true, holderWorkerId: 'w-root' });
  });

  for (const status of ['waiting', 'working', 'stale', 'idle']) {
    test(`${status} holder is never eligible`, () => {
      const d = classifyResumeBranchHolder(registry({ status }), HOLDER, lineage, 'w-new');
      expect(d.eligible).toBe(false);
      if (!d.eligible) expect(d.reason).toBe('holder_live');
    });
  }

  test('any live co-owner of the path blocks release even if a terminal one also matches', () => {
    const workers: Array<[string, LineageHolderRecord]> = [
      ['w-prior', { worktreePath: HOLDER, status: 'done', taskId: 'task-A' }],
      ['w-other', { worktreePath: HOLDER, status: 'waiting', taskId: 'task-A' }],
    ];
    const d = classifyResumeBranchHolder(workers, HOLDER, lineage, 'w-new');
    expect(d.eligible).toBe(false);
  });

  test('holder outside the lineage is not eligible', () => {
    const d = classifyResumeBranchHolder(registry({ taskId: 'task-Z' }), HOLDER, lineage, 'w-new');
    expect(d).toEqual({ eligible: false, reason: 'outside_lineage', holderWorkerId: 'w-prior' });
  });

  test('a path no registry worker owns is not eligible (no path guessing)', () => {
    const d = classifyResumeBranchHolder(registry({ worktreePath: '/other' }), HOLDER, lineage, 'w-new');
    expect(d).toEqual({ eligible: false, reason: 'no_registry_owner' });
  });

  test('no lineage supplied is not eligible', () => {
    const d = classifyResumeBranchHolder(registry({}), HOLDER, undefined, 'w-new');
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reason).toBe('no_lineage');
  });

  test('the calling worker itself is ignored', () => {
    const d = classifyResumeBranchHolder(registry({ id: 'w-new' }), HOLDER, lineage, 'w-new');
    expect(d).toEqual({ eligible: false, reason: 'no_registry_owner' });
  });
});

describe('resolveReleaseHeldBranchMode', () => {
  test('defaults to shadow', () => {
    expect(resolveReleaseHeldBranchMode({})).toBe('shadow');
    expect(resolveReleaseHeldBranchMode({ BUILDD_RELEASE_LINEAGE_HELD_BRANCH: '' })).toBe('shadow');
    expect(resolveReleaseHeldBranchMode({ BUILDD_RELEASE_LINEAGE_HELD_BRANCH: '0' })).toBe('shadow');
    expect(resolveReleaseHeldBranchMode({ BUILDD_RELEASE_LINEAGE_HELD_BRANCH: 'off' })).toBe('shadow');
  });
  test('1/true/on enables release', () => {
    for (const v of ['1', 'true', 'on', 'TRUE']) {
      expect(resolveReleaseHeldBranchMode({ BUILDD_RELEASE_LINEAGE_HELD_BRANCH: v })).toBe('release');
    }
  });
});

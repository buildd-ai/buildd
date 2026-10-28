import { describe, expect, it } from 'bun:test';
import { recheckMissionAfterMerge, recheckReason, type RecheckDeps } from './mission-verify-recheck';

const build = (id: string, status = 'completed') => ({ id, status, title: `Build ${id}`, taskClass: 'work', context: null });
const repair = (id: string, status = 'completed') => ({ id, status, title: `Fix ${id}`, taskClass: 'work', context: { specRepair: { criterionId: 'AC-1', specId: 's' } } });
const missionPr = { id: 'mpr', status: 'completed', title: 'Ship mission: Cloud runner deploy', taskClass: 'bookkeeping', context: null };
const audit = { id: 'aud', status: 'completed', title: 'Verify', taskClass: 'work', context: { finalVerification: { specId: 's' } } };

describe('recheckReason: verification runs by itself (Navigation R-19)', () => {
  it('the last build task merging completes the build', () => {
    expect(recheckReason('b2', [build('b1'), build('b2', 'in_progress')])).toBe('build_complete');
  });

  it('a build merge while other build work is open owes nothing yet', () => {
    expect(recheckReason('b1', [build('b1'), build('b2', 'in_progress')])).toBeNull();
  });

  it('a later build merge once built changes the merged result, so it re-checks too', () => {
    expect(recheckReason('b3', [build('b1'), build('b2'), build('b3')])).toBe('build_complete');
  });

  it('a cancelled build task does not hold the build open', () => {
    expect(recheckReason('b1', [build('b1'), build('b2', 'cancelled')])).toBe('build_complete');
  });

  it('a repair merging re-checks what it fixed, even with build work open', () => {
    expect(recheckReason('r1', [build('b1', 'in_progress'), repair('r1')])).toBe('repair_merged');
  });

  it('the mission PR merging moves the result to its target', () => {
    expect(recheckReason('mpr', [build('b1'), missionPr])).toBe('target_changed');
  });

  it('a verification task or an unknown task owes nothing', () => {
    expect(recheckReason('aud', [build('b1'), audit])).toBeNull();
    expect(recheckReason('nope', [build('b1')])).toBeNull();
  });

  it('zero build tasks never completes the build', () => {
    expect(recheckReason('b1', [audit])).toBeNull();
  });

  it('a reopened build task blocks the recheck for another build merge', () => {
    expect(recheckReason('b2', [build('b1', 'pending'), build('b2', 'in_progress'), build('b3')])).toBeNull();
  });
});

describe('recheckMissionAfterMerge', () => {
  function deps(over: Partial<RecheckDeps> = {}, calls: string[] = []): RecheckDeps {
    return {
      mission: async () => ({ status: 'active', goalCriteria: [{ type: 'living_spec' }] }),
      tasks: async () => [build('b1'), repair('r1')],
      ensure: async (_id, trigger) => { calls.push(trigger); return null; },
      ...over,
    };
  }

  it('asks for a verdict with the reason as its trigger', async () => {
    const calls: string[] = [];
    expect(await recheckMissionAfterMerge('m1', 'r1', deps({}, calls))).toBe('repair_merged');
    expect(calls).toEqual(['repair_merged']);
  });

  it('no criteria, a closed mission or nothing owed: no evaluation', async () => {
    const calls: string[] = [];
    expect(await recheckMissionAfterMerge('m1', 'r1', deps({ mission: async () => ({ status: 'active', goalCriteria: [] }) }, calls))).toBeNull();
    expect(await recheckMissionAfterMerge('m1', 'r1', deps({ mission: async () => ({ status: 'cancelled', goalCriteria: [{}] }) }, calls))).toBeNull();
    expect(await recheckMissionAfterMerge('m1', 'b1', deps({ tasks: async () => [build('b1'), build('b2', 'pending')] }, calls))).toBeNull();
    expect(calls).toEqual([]);
  });

  it('never throws: a failed evaluation is logged', async () => {
    expect(await recheckMissionAfterMerge('m1', 'r1', deps({ ensure: async () => { throw new Error('boom'); } }))).toBeNull();
  });
});

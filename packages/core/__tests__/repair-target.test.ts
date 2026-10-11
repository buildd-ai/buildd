import { describe, it, expect } from 'bun:test';
import { readRepairTarget, repairBranchContext } from '../repair-target';

describe('repairBranchContext', () => {
  it('names the GitHub-reported head on both branch fields and stamps the target', () => {
    const ctx = repairBranchContext({ prNumber: 12, workerBranch: 'buildd/abc', headRef: 'mission/m-1a2b3c4d', headSha: 'h1', baseRef: 'dev' });
    expect(ctx).toEqual({
      baseBranch: 'mission/m-1a2b3c4d',
      resumeBranch: 'mission/m-1a2b3c4d',
      repairTarget: { prNumber: 12, headRef: 'mission/m-1a2b3c4d', headSha: 'h1', baseRef: 'dev' },
    });
    expect(readRepairTarget(ctx as never)?.prNumber).toBe(12);
  });

  it('without a reported head keeps the worker branch and claims no target', () => {
    const ctx = repairBranchContext({ prNumber: 12, workerBranch: 'buildd/abc', headRef: null });
    expect(ctx).toEqual({ baseBranch: 'buildd/abc', resumeBranch: 'buildd/abc' });
    expect(readRepairTarget(ctx as never)).toBeNull();
  });
});

describe('readRepairTarget', () => {
  it('ignores a stamp that no longer matches resumeBranch', () => {
    expect(readRepairTarget({ resumeBranch: 'x', repairTarget: { prNumber: 1, headRef: 'y' } })).toBeNull();
  });
  it('ignores malformed stamps', () => {
    expect(readRepairTarget({ resumeBranch: 'y', repairTarget: { headRef: 'y' } })).toBeNull();
    expect(readRepairTarget(null)).toBeNull();
  });
});

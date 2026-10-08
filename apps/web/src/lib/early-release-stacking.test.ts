import { describe, it, expect } from 'bun:test';
import {
  findStackedReleaseForBase,
  undraftStackedDependents,
  type UndraftStackedDependentsDeps,
} from './early-release-stacking';

describe('findStackedReleaseForBase', () => {
  const UPSTREAM_BRANCH = 'buildd/9f8e7d6c-upstream-thing';

  it('is true when a non-revoked start_stacked release names this exact base', async () => {
    const found = await findStackedReleaseForBase('dep-1', UPSTREAM_BRANCH, {
      findRelease: async (taskId, base) => {
        expect(taskId).toBe('dep-1');
        expect(base).toBe(UPSTREAM_BRANCH);
        return { id: 'release-1' };
      },
    });
    expect(found).toBe(true);
  });

  it('is false when no release row matches', async () => {
    const found = await findStackedReleaseForBase('dep-1', UPSTREAM_BRANCH, {
      findRelease: async () => null,
    });
    expect(found).toBe(false);
  });

  it('is false for a missing taskId or baseBranch without even querying', async () => {
    const neverCalled = async () => {
      throw new Error('findRelease should not have been called');
    };
    expect(await findStackedReleaseForBase(null, UPSTREAM_BRANCH, { findRelease: neverCalled })).toBe(false);
    expect(await findStackedReleaseForBase('dep-1', undefined, { findRelease: neverCalled })).toBe(false);
  });
});

describe('undraftStackedDependents', () => {
  function harness(overrides: Partial<UndraftStackedDependentsDeps> = {}) {
    const markReadyCalls: Array<[number, string, number]> = [];
    const deps: UndraftStackedDependentsDeps = {
      findStackedDependentTaskIds: async () => ['dep-1'],
      findOpenPrForTask: async () => ({ prNumber: 77, installationId: 12345, repoFullName: 'owner/repo' }),
      markReady: async (installationId, repoFullName, prNumber) => {
        markReadyCalls.push([installationId, repoFullName, prNumber]);
        return { ok: true };
      },
      ...overrides,
    };
    return { deps, markReadyCalls };
  }

  it('un-drafts the open PR of every stacked dependent', async () => {
    const { deps, markReadyCalls } = harness();
    await undraftStackedDependents('upstream-1', deps);
    expect(markReadyCalls).toEqual([[12345, 'owner/repo', 77]]);
  });

  it('does nothing when there are no stacked dependents', async () => {
    const { deps, markReadyCalls } = harness({ findStackedDependentTaskIds: async () => [] });
    await undraftStackedDependents('upstream-1', deps);
    expect(markReadyCalls).toHaveLength(0);
  });

  it('skips a dependent with no open PR to act on', async () => {
    const { deps, markReadyCalls } = harness({ findOpenPrForTask: async () => null });
    await undraftStackedDependents('upstream-1', deps);
    expect(markReadyCalls).toHaveLength(0);
  });

  it('one dependent failing does not stop the rest', async () => {
    const markReadyCalls: Array<[number, string, number]> = [];
    await undraftStackedDependents('upstream-1', {
      findStackedDependentTaskIds: async () => ['dep-1', 'dep-2'],
      findOpenPrForTask: async (taskId) =>
        taskId === 'dep-1'
          ? ({ prNumber: 1, installationId: 1, repoFullName: 'owner/repo' })
          : ({ prNumber: 2, installationId: 1, repoFullName: 'owner/repo' }),
      markReady: async (installationId, repoFullName, prNumber) => {
        if (prNumber === 1) throw new Error('boom');
        markReadyCalls.push([installationId, repoFullName, prNumber]);
        return { ok: true };
      },
    });
    expect(markReadyCalls).toEqual([[1, 'owner/repo', 2]]);
  });

  it('logs but does not throw when markReady itself reports failure', async () => {
    const { deps } = harness({
      markReady: async () => ({ ok: false, message: 'GitHub said no' }),
    });
    await expect(undraftStackedDependents('upstream-1', deps)).resolves.toBeUndefined();
  });
});

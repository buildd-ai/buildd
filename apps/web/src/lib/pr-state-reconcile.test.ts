process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';

let updates: Array<{ set: Record<string, unknown>; }> = [];
let joinRows: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: { missions: { findFirst: () => Promise.resolve({ id: 'm1' }) } },
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => Promise.resolve(joinRows) }),
        where: () => Promise.resolve(joinRows),
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          updates.push({ set });
          return Promise.resolve();
        },
      }),
    }),
  },
}));

const { reconcileWorkerPrState, parsePrUrl } = await import('./pr-state-reconcile');

function worker(over: Record<string, unknown> = {}) {
  return {
    id: 'w1',
    prUrl: 'https://github.com/maxjacu/moa-ops/pull/146',
    prNumber: 146,
    mergedAt: null,
    prLifecycleStatus: null,
    workspaceId: 'ws1',
    ...over,
  } as any;
}

const githubApi = (res: Record<string, unknown> | Error) =>
  (() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res))) as any;

beforeEach(() => {
  updates = [];
  // workspace → installation join
  joinRows = [{ workspaceId: 'ws1', installationId: 155534927 }];
});

describe('parsePrUrl', () => {
  it('extracts repo and number', () => {
    expect(parsePrUrl('https://github.com/maxjacu/moa-ops/pull/146')).toEqual({
      repo: 'maxjacu/moa-ops',
      number: 146,
    });
  });

  it('rejects anything that is not a github PR url', () => {
    expect(parsePrUrl('https://github.com/maxjacu/moa-ops')).toBeNull();
    expect(parsePrUrl('https://gitlab.com/a/b/pull/1')).toBeNull();
  });
});

describe('reconcileWorkerPrState', () => {
  // The exact production bug: moa-ops#146 merged on GitHub, buildd had null.
  it('stamps mergedAt when GitHub says merged and buildd does not know', async () => {
    const res = await reconcileWorkerPrState([worker()], {
      githubApi: githubApi({ merged_at: '2026-08-21T18:56:20Z', state: 'closed' }),
    });

    expect(res.fixes).toHaveLength(1);
    expect(res.fixes[0].before).toEqual({ mergedAt: null, prLifecycleStatus: null });
    expect(res.fixes[0].after).toEqual({
      mergedAt: '2026-08-21T18:56:20Z',
      prLifecycleStatus: 'merged',
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].set.prLifecycleStatus).toBe('merged');
  });

  // The other half: a worker wrongly marked merged by a colliding PR number.
  it('clears mergedAt when GitHub says the PR was closed without merging', async () => {
    const res = await reconcileWorkerPrState(
      [worker({ mergedAt: '2026-08-05T10:56:25Z', prLifecycleStatus: 'merged' })],
      { githubApi: githubApi({ merged_at: null, state: 'closed' }) },
    );

    expect(res.fixes).toHaveLength(1);
    expect(res.fixes[0].after).toEqual({ mergedAt: null, prLifecycleStatus: 'closed' });
    expect(updates[0].set.mergedAt).toBeNull();
  });

  it('marks an open PR as pr_open', async () => {
    const res = await reconcileWorkerPrState([worker()], {
      githubApi: githubApi({ merged_at: null, state: 'open' }),
    });
    expect(res.fixes[0].after.prLifecycleStatus).toBe('pr_open');
  });

  it('is a no-op when buildd already agrees with GitHub', async () => {
    const res = await reconcileWorkerPrState(
      [worker({ mergedAt: '2026-08-21T18:56:22Z', prLifecycleStatus: 'merged' })],
      { githubApi: githubApi({ merged_at: '2026-08-21T18:56:20Z', state: 'closed' }) },
    );

    // 2s apart — buildd stamps its own clock a beat after GitHub's merge.
    expect(res.fixes).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('treats a merge instant more than a minute off as wrong', async () => {
    const res = await reconcileWorkerPrState(
      [worker({ mergedAt: '2026-08-21T18:56:22Z', prLifecycleStatus: 'merged' })],
      { githubApi: githubApi({ merged_at: '2026-02-21T12:24:43Z', state: 'closed' }) },
    );
    expect(res.fixes).toHaveLength(1);
    expect(res.fixes[0].after.mergedAt).toBe('2026-02-21T12:24:43Z');
  });

  it('writes nothing in dryRun but still reports the fix', async () => {
    const res = await reconcileWorkerPrState([worker()], {
      dryRun: true,
      githubApi: githubApi({ merged_at: '2026-08-21T18:56:20Z', state: 'closed' }),
    });

    expect(res.fixes).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it('reports rather than throws when GitHub errors', async () => {
    const res = await reconcileWorkerPrState([worker()], {
      githubApi: githubApi(new Error('GitHub API error: 404')),
    });

    expect(res.fixes).toHaveLength(0);
    expect(res.unverified).toEqual([
      { prUrl: 'https://github.com/maxjacu/moa-ops/pull/146', reason: 'GitHub API error: 404' },
    ]);
  });

  it('skips workspaces with no GitHub installation instead of guessing', async () => {
    joinRows = [];
    const res = await reconcileWorkerPrState([worker()], {
      githubApi: githubApi({ merged_at: '2026-08-21T18:56:20Z' }),
    });

    expect(res.fixes).toHaveLength(0);
    expect(res.unverified[0].reason).toBe('workspace has no GitHub installation');
  });
});

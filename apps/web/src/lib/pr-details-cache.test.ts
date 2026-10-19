import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * fetchPrDetails is the GitHub half of the task page's PR card, run only by
 * the after-response refresh (the render reads the cached answer). What it
 * must get right: the live CI/review/mergeability view, check runs of earlier
 * attempt heads, a re-run replacing its earlier run, the latest review per
 * user — and null, not a throw, when the workspace has no installation or repo.
 */

let workspaceRow: any = {
  githubInstallation: { installationId: 42 },
  githubRepo: { fullName: 'owner/repo' },
};

mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findFirst: async () => workspaceRow } } },
}));

const githubResponses = new Map<string, unknown>();
let githubThrowsOn: string | null = null;

mock.module('@/lib/github', () => ({
  githubApi: async (_installId: number, path: string) => {
    if (githubThrowsOn && path.includes(githubThrowsOn)) throw new Error('github down');
    for (const [fragment, value] of githubResponses) {
      if (path.includes(fragment)) return value;
    }
    return null;
  },
}));

const { fetchPrDetails, prDetailsKey, prDetailsOf, prDetailsTtlMs, PR_DETAILS_PENDING_MS, PR_DETAILS_SETTLED_MS } = await import('./pr-details-cache');

describe('fetchPrDetails', () => {
  beforeEach(() => {
    githubThrowsOn = null;
    workspaceRow = { githubInstallation: { installationId: 42 }, githubRepo: { fullName: 'owner/repo' } };
    githubResponses.clear();
  });

  it('carries the live CI, review and mergeability view', async () => {
    githubResponses.set('/pulls/7/reviews', [
      { user: { login: 'a' }, state: 'APPROVED' },
      { user: { login: 'b' }, state: 'CHANGES_REQUESTED' },
    ]);
    githubResponses.set('/check-runs', {
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'e2e', status: 'completed', conclusion: 'failure', details_url: 'https://x.test/1' },
        { name: 'lint', status: 'in_progress', conclusion: null },
      ],
    });
    githubResponses.set('/pulls/7', { head: { sha: 'abc' }, mergeable: true, mergeable_state: 'clean' });

    const d = (await fetchPrDetails('ws-1', 7, []))!;
    expect(d.ciChecks).toEqual({
      total: 3, passed: 1, failed: 1, pending: 1,
      runs: [
        { name: 'build', conclusion: 'success', status: 'completed', detailsUrl: null },
        { name: 'e2e', conclusion: 'failure', status: 'completed', detailsUrl: 'https://x.test/1' },
        { name: 'lint', conclusion: null, status: 'in_progress', detailsUrl: null },
      ],
    });
    expect(d.reviews).toEqual({ approved: 1, changesRequested: 1, pending: 0, commented: 0 });
    expect(d.mergeable).toBe(true);
    expect(d.mergeableState).toBe('clean');
    expect(d.headSha).toBe('abc');
  });

  it('fetches check runs for an earlier attempt head as well as the PR head', async () => {
    githubResponses.set('/commits/failedsha1/check-runs', { check_runs: [{ name: 'unit', status: 'completed', conclusion: 'failure' }] });
    githubResponses.set('/commits/headsha2/check-runs', { check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success' }] });
    githubResponses.set('/pulls/7', { head: { sha: 'headsha2' } });
    const d = (await fetchPrDetails('ws-1', 7, ['failedsha1', 'headsha2']))!;
    expect(d.runsByRef).toEqual({ failedsha1: [{ name: 'unit', status: 'completed', conclusion: 'failure', detailsUrl: null }] });
    expect(d.ciChecks?.runs).toEqual([{ name: 'unit', status: 'completed', conclusion: 'success', detailsUrl: null }]);
  });

  it('a run its re-run replaced is not counted (6900a317)', async () => {
    const runs = [
      { id: 1, name: 'build', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'check', status: 'completed', conclusion: 'failure' },
      { id: 3, name: 'check', status: 'completed', conclusion: 'success' },
      { id: 4, name: 'next build', status: 'in_progress', conclusion: null },
    ];
    githubResponses.set('/commits/oldsha1/check-runs', { check_runs: runs });
    githubResponses.set('/commits/headsha2/check-runs', { check_runs: runs });
    githubResponses.set('/pulls/7', { head: { sha: 'headsha2' } });
    const d = (await fetchPrDetails('ws-1', 7, ['oldsha1']))!;
    expect(d.ciChecks).toMatchObject({ total: 3, passed: 2, failed: 0, pending: 1 });
    expect(d.runsByRef.oldsha1.map(r => [r.name, r.conclusion])).toEqual([['build', 'success'], ['check', 'success'], ['next build', null]]);
  });

  it('counts only the latest review per user', async () => {
    githubResponses.set('/pulls/7/reviews', [
      { user: { login: 'a' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'a' }, state: 'APPROVED' },
      { user: { login: 'a' }, state: 'COMMENTED' },
    ]);
    githubResponses.set('/pulls/7', { head: { sha: 'abc' } });
    expect((await fetchPrDetails('ws-1', 7, []))!.reviews).toEqual({ approved: 1, changesRequested: 0, pending: 0, commented: 0 });
  });

  it('is null with no installation or no repo, and throws when GitHub does (the refresh catches it)', async () => {
    workspaceRow = { githubRepo: { fullName: 'owner/repo' } };
    expect(await fetchPrDetails('ws-1', 7, [])).toBeNull();
    workspaceRow = { githubInstallation: { installationId: 42 } };
    expect(await fetchPrDetails('ws-1', 7, [])).toBeNull();
    workspaceRow = { githubInstallation: { installationId: 42 }, githubRepo: { fullName: 'owner/repo' } };
    githubThrowsOn = '/pulls/7';
    await expect(fetchPrDetails('ws-1', 7, [])).rejects.toThrow('github down');
  });
});

describe('cache key and freshness', () => {
  it('keys by PR head, so a new push reads as missing', () => {
    expect(prDetailsKey('ws', 7, 'aaa')).not.toBe(prDetailsKey('ws', 7, 'bbb'));
    expect(prDetailsKey('ws', 7, null)).toBe(prDetailsKey('ws', 7, undefined));
  });

  it('refreshes sooner while CI runs or mergeability is unknown', () => {
    const settled = { headSha: 'a', ciChecks: { total: 1, passed: 1, failed: 0, pending: 0, runs: [] }, reviews: { approved: 0, changesRequested: 0, pending: 0 }, mergeable: true, mergeableState: 'clean', runsByRef: {} };
    expect(prDetailsTtlMs(settled)).toBe(PR_DETAILS_SETTLED_MS);
    expect(prDetailsTtlMs({ ...settled, ciChecks: { ...settled.ciChecks, pending: 1 } })).toBe(PR_DETAILS_PENDING_MS);
    expect(prDetailsTtlMs({ ...settled, mergeable: null })).toBe(PR_DETAILS_PENDING_MS);
  });
});

describe('prDetailsOf (the cached jsonb read back)', () => {
  const stored = {
    headSha: 'abc', ciChecks: null, reviews: { approved: 1, changesRequested: 0, pending: 0 },
    mergeable: true, mergeableState: 'clean', runsByRef: {},
  };

  it('returns a stored answer', () => {
    expect(prDetailsOf({ details: stored })).toEqual(stored);
  });

  it('reads a claim placeholder, a missing row value or a malformed one as no answer', () => {
    expect(prDetailsOf({ details: null })).toBeNull();
    expect(prDetailsOf(null)).toBeNull();
    expect(prDetailsOf('details')).toBeNull();
    expect(prDetailsOf({ details: 'stale' })).toBeNull();
    expect(prDetailsOf({ details: { headSha: 'abc' } })).toBeNull();
    expect(prDetailsOf({ details: { ...stored, runsByRef: null } })).toBeNull();
  });
});

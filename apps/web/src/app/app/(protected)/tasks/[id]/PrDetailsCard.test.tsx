import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * PrDetailsCard is the GitHub half of the PR panel, behind a Suspense
 * boundary. Rendering it never calls GitHub (spec 3ef37387 R-14, R-15): it
 * reads the answer cached for this PR head and, when that is missing or old,
 * refreshes it after the response (lib/pr-details-cache.ts), so an open
 * page's live refreshes do not each make GitHub calls.
 *
 *  - a cached answer carries the CI/review/mergeability view and the runs of
 *    each attempt's commit;
 *  - nothing cached, or the cache unreadable, renders the stored card; an
 *    exception escaping an async server component inside a Suspense boundary
 *    is an error boundary, not a degraded card.
 */

let cached: { details: any; fresh: boolean } = { details: null, fresh: false };
let readThrows = false;
const refreshes: unknown[] = [];
const afterCalls: Array<() => unknown> = [];
const keys: unknown[] = [];

const realCache = await import('@/lib/pr-details-cache');
mock.module('@/lib/pr-details-cache', () => ({
  ...realCache,
  readPrDetails: async (key: string) => {
    keys.push(key);
    if (readThrows) throw new Error('db down');
    return cached;
  },
  refreshPrDetails: async (input: unknown) => { refreshes.push(input); },
}));
const nextServer = await import('next/server');
mock.module('next/server', () => ({ ...nextServer, after: (fn: () => unknown) => { afterCalls.push(fn); } }));

const PrCard = (await import('@/components/task/PrCard')).default;
const mod = await import('./PrDetailsCard');
const PrDetailsCard = mod.default;
const { StoredPrCard } = mod;

const FACTS = {
  prUrl: 'https://github.com/owner/repo/pull/7',
  prNumber: 7,
  prLifecycleStatus: 'open',
  linesAdded: 10,
  linesRemoved: 2,
  filesChanged: 3,
};

const DETAILS = {
  headSha: 'headsha2',
  ciChecks: { total: 2, passed: 1, failed: 1, pending: 0, runs: [{ name: 'unit', status: 'completed', conclusion: 'success', detailsUrl: null }] },
  reviews: { approved: 1, changesRequested: 0, pending: 0 },
  mergeable: true,
  mergeableState: 'clean',
  runsByRef: { failedsha1: [{ name: 'unit', status: 'completed', conclusion: 'failure', detailsUrl: null }] },
};

/** Resolves one level of indirection so assertions read the PrCard props. */
function prCardPropsOf(element: any): any {
  if (element.type === StoredPrCard) return prCardPropsOf(StoredPrCard(element.props));
  expect(element.type).toBe(PrCard);
  return element.props;
}

describe('PrDetailsCard', () => {
  beforeEach(() => {
    cached = { details: null, fresh: false };
    readThrows = false;
    refreshes.length = 0;
    afterCalls.length = 0;
    keys.length = 0;
  });

  it('a fresh cached answer carries the CI, review and mergeability view, and schedules nothing', async () => {
    cached = { details: DETAILS, fresh: true };
    const props = prCardPropsOf(await PrDetailsCard({ workspaceId: 'ws-1', headSha: 'headsha2', ...FACTS }));
    expect(props.ciChecks).toEqual(DETAILS.ciChecks);
    expect(props.reviews).toEqual(DETAILS.reviews);
    expect(props.mergeable).toBe(true);
    expect(props.mergeableState).toBe('clean');
    // Stored facts survive the enrichment.
    expect(props.prNumber).toBe(7);
    expect(props.linesAdded).toBe(10);
    expect(afterCalls).toHaveLength(0);
    // Keyed by the PR head the page knows.
    expect(keys).toEqual([realCache.prDetailsKey('ws-1', 7, 'headsha2')]);
  });

  it('applies each commit its own runs: the head from the PR, an earlier attempt head from runsByRef', async () => {
    cached = { details: DETAILS, fresh: true };
    const outcome = {
      totals: { add: 1, rem: 0, files: 1, commits: 2, attempts: 2, claimToMerge: null },
      attempts: [{ add: 1, rem: 0, files: 1 }],
      lineage: [],
      commits: [
        { attempt: 1, sha: 'faileds', ref: 'failedsha1', state: 'failed' as const, failure: null },
        { attempt: 2, sha: 'headsha', ref: 'headsha2', state: 'passed' as const, failure: null },
      ],
    };
    const props = prCardPropsOf(await PrDetailsCard({ workspaceId: 'ws-1', ...FACTS, outcome } as any));
    expect(props.outcome.commits[0].runs).toEqual(DETAILS.runsByRef.failedsha1);
    expect(props.outcome.commits[1].runs).toEqual(DETAILS.ciChecks.runs);
  });

  it('an old answer still renders, and is refreshed after the response with the attempt heads', async () => {
    cached = { details: DETAILS, fresh: false };
    const outcome = { totals: {}, attempts: [], lineage: [], commits: [{ attempt: 1, sha: 'x', ref: 'failedsha1', state: 'failed', failure: null }] };
    const props = prCardPropsOf(await PrDetailsCard({ workspaceId: 'ws-1', headSha: 'headsha2', ...FACTS, outcome } as any));
    expect(props.ciChecks).toEqual(DETAILS.ciChecks);
    expect(refreshes).toHaveLength(0);
    expect(afterCalls).toHaveLength(1);
    await afterCalls[0]();
    expect(refreshes).toEqual([{ key: realCache.prDetailsKey('ws-1', 7, 'headsha2'), workspaceId: 'ws-1', prNumber: 7, otherRefs: ['failedsha1'] }]);
  });

  it('with nothing cached it renders the stored card and refreshes after the response', async () => {
    const props = prCardPropsOf(await PrDetailsCard({ workspaceId: 'ws-1', ...FACTS }));
    expect(props.prUrl).toBe(FACTS.prUrl);
    expect(props.ciChecks).toBeNull();
    expect(props.reviews).toBeNull();
    expect(props.mergeable).toBeNull();
    expect(afterCalls).toHaveLength(1);
  });

  it('never rejects: an unreadable cache renders the stored card', async () => {
    readThrows = true;
    const props = prCardPropsOf(await PrDetailsCard({ workspaceId: 'ws-1', ...FACTS }));
    expect(props.prNumber).toBe(7);
    expect(props.filesChanged).toBe(3);
    expect(props.ciChecks).toBeNull();
  });

  it('renders the stored-state fallback without touching GitHub or the database', () => {
    const props = prCardPropsOf(StoredPrCard(FACTS));
    expect(props.ciChecks).toBeNull();
    expect(props.prUrl).toBe(FACTS.prUrl);
  });
});

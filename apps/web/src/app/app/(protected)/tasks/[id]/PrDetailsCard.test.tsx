import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * PrDetailsCard is the GitHub half of the PR panel, moved off the task-detail
 * critical path and behind a Suspense boundary. Two things have to hold:
 *
 *  - when GitHub answers, the card carries the live CI/review/mergeability view;
 *  - when anything on that path fails — no installation, no repo, a throwing
 *    REST call — the card still renders from stored state, because merge state
 *    is already in the database and the panel was non-fatal before this moved.
 *
 * The second is the one worth testing: an exception escaping an async server
 * component inside a Suspense boundary is an error boundary, not a degraded
 * card, so "non-fatal" stopped being free the moment this stopped being a
 * try/catch in the page body.
 */

let workspaceRow: any = {
  githubInstallation: { installationId: 42 },
  githubRepo: { fullName: 'owner/repo' },
};
let workspaceThrows = false;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: {
        findFirst: async () => {
          if (workspaceThrows) throw new Error('db down');
          return workspaceRow;
        },
      },
    },
  },
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

/** Resolves one level of indirection so assertions read the PrCard props. */
function prCardPropsOf(element: any): any {
  if (element.type === StoredPrCard) return prCardPropsOf(StoredPrCard(element.props));
  expect(element.type).toBe(PrCard);
  return element.props;
}

describe('PrDetailsCard', () => {
  beforeEach(() => {
    workspaceThrows = false;
    githubThrowsOn = null;
    workspaceRow = {
      githubInstallation: { installationId: 42 },
      githubRepo: { fullName: 'owner/repo' },
    };
    githubResponses.clear();
  });

  it('carries the live CI, review and mergeability view when GitHub answers', async () => {
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

    const props = prCardPropsOf(await PrDetailsCard({ workspaceId: 'ws-1', ...FACTS }));
    expect(props.ciChecks).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      pending: 1,
      runs: [
        { name: 'build', conclusion: 'success', status: 'completed', detailsUrl: null },
        { name: 'e2e', conclusion: 'failure', status: 'completed', detailsUrl: 'https://x.test/1' },
        { name: 'lint', conclusion: null, status: 'in_progress', detailsUrl: null },
      ],
    });
    expect(props.reviews).toEqual({ approved: 1, changesRequested: 1, pending: 0 });
    expect(props.mergeable).toBe(true);
    expect(props.mergeableState).toBe('clean');
    // Stored facts survive the enrichment.
    expect(props.prNumber).toBe(7);
    expect(props.linesAdded).toBe(10);
  });

  it('counts only the latest review per user', async () => {
    githubResponses.set('/pulls/7/reviews', [
      { user: { login: 'a' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'a' }, state: 'APPROVED' },
      { user: { login: 'a' }, state: 'COMMENTED' },
    ]);
    githubResponses.set('/pulls/7', { head: { sha: 'abc' } });
    const props = prCardPropsOf(await PrDetailsCard({ workspaceId: 'ws-1', ...FACTS }));
    expect(props.reviews).toEqual({ approved: 1, changesRequested: 0, pending: 0 });
  });

  const degradations: Array<[string, () => void]> = [
    ['the workspace read throws', () => { workspaceThrows = true; }],
    ['the workspace has no GitHub installation', () => { workspaceRow = { githubRepo: { fullName: 'owner/repo' } }; }],
    ['the workspace has no linked repo', () => { workspaceRow = { githubInstallation: { installationId: 42 } }; }],
    ['fetching the PR throws', () => { githubThrowsOn = '/pulls/7'; }],
  ];

  for (const [label, arrange] of degradations) {
    it(`still renders the card from stored state when ${label}`, async () => {
      arrange();
      const props = prCardPropsOf(await PrDetailsCard({ workspaceId: 'ws-1', ...FACTS }));
      expect(props.prUrl).toBe(FACTS.prUrl);
      expect(props.prNumber).toBe(7);
      expect(props.prLifecycleStatus).toBe('open');
      expect(props.filesChanged).toBe(3);
      expect(props.ciChecks).toBeNull();
      expect(props.reviews).toBeNull();
      expect(props.mergeable).toBeNull();
    });
  }

  it('never rejects — a throw would trip an error boundary, not degrade the card', async () => {
    workspaceThrows = true;
    await expect(PrDetailsCard({ workspaceId: 'ws-1', ...FACTS })).resolves.toBeDefined();
  });

  it('renders the stored-state fallback without touching GitHub or the database', () => {
    const props = prCardPropsOf(StoredPrCard(FACTS));
    expect(props.ciChecks).toBeNull();
    expect(props.prUrl).toBe(FACTS.prUrl);
  });
});

import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockGithubApi = mock((_i: number, _p: string) => Promise.resolve(null as any));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mock(() => Promise.resolve()),
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { RELEASE_UPDATED: 'release:updated' },
}));
mock.module('@/lib/release-verification', () => ({ verifyReleaseDeployment: mock(() => Promise.resolve()) }));
mock.module('@buildd/core/db', () => ({ db: {} }));

const { findMergedReleasePrContaining, commitContains } = await import('./gated-merge');

const BASE = {
  installationId: 42,
  repoFullName: 'org/repo',
  prodBranch: 'main',
  headRef: 'dev',
  sha: 'dev-sha',
  since: new Date('2026-01-10T00:00:00Z'),
};

function pr(number: number, mergedAt: string | null, headSha: string, title = `Release v1.0.${number}`) {
  return { number, title, merged_at: mergedAt, merge_commit_sha: `merge-${number}`, head: { sha: headSha } };
}

function github(pulls: any[] | Error, compare: Record<string, string | Error>) {
  mockGithubApi.mockImplementation(((_i: number, path: string) => {
    if (path.includes('/pulls?')) return pulls instanceof Error ? Promise.reject(pulls) : Promise.resolve(pulls);
    const m = /\/compare\/[^.]+\.\.\.(.+)$/.exec(path);
    if (m) {
      const r = compare[decodeURIComponent(m[1]!)];
      if (!r) return Promise.reject(new Error('GitHub API error: 404'));
      return r instanceof Error ? Promise.reject(r) : Promise.resolve({ status: r });
    }
    return Promise.resolve(null);
  }) as any);
}

beforeEach(() => mockGithubApi.mockReset());

describe('findMergedReleasePrContaining', () => {
  it('asks for closed release-ref → prod PRs', async () => {
    github([], {});
    await findMergedReleasePrContaining(BASE);
    const path = String(mockGithubApi.mock.calls[0]?.[1]);
    expect(path).toContain('/repos/org/repo/pulls?state=closed&base=main');
    expect(path).toContain(`head=${encodeURIComponent('org:dev')}`);
  });

  it('returns the earliest merged PR after dispatch whose head contains the sha', async () => {
    github(
      [
        pr(3, '2026-01-12T00:00:00Z', 'head-3'),
        pr(2, '2026-01-11T00:00:00Z', 'head-2'),
        pr(1, '2026-01-09T00:00:00Z', 'head-1'), // before dispatch — ignored
        pr(4, null, 'head-4'), // closed unmerged — ignored
      ],
      { 'head-2': 'ahead', 'head-3': 'ahead', 'head-1': 'ahead' },
    );
    const found = await findMergedReleasePrContaining(BASE);
    expect(found).toEqual({ number: 2, title: 'Release v1.0.2', mergeCommitSha: 'merge-2', headSha: 'head-2' });
  });

  it('returns null when GitHub answered and no merged PR contains the sha', async () => {
    github([pr(2, '2026-01-11T00:00:00Z', 'head-2')], { 'head-2': 'diverged' });
    expect(await findMergedReleasePrContaining(BASE)).toBeNull();
  });

  it("returns 'unknown' when a compare could not be answered", async () => {
    github([pr(2, '2026-01-11T00:00:00Z', 'head-2')], { 'head-2': new Error('GitHub API error: 500') });
    expect(await findMergedReleasePrContaining(BASE)).toBe('unknown');
  });

  it("returns 'unknown' when the PR list call fails or there is no identity", async () => {
    github(new Error('GitHub API error: 502'), {});
    expect(await findMergedReleasePrContaining(BASE)).toBe('unknown');
    expect(await findMergedReleasePrContaining({ ...BASE, installationId: null })).toBe('unknown');
    expect(await findMergedReleasePrContaining({ ...BASE, repoFullName: null })).toBe('unknown');
  });
});

describe('commitContains', () => {
  it('is true for identical shas without an API call', async () => {
    expect(await commitContains(undefined, 'org/repo', 'a', 'a')).toBe(true);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it.each([
    ['ahead', true],
    ['identical', true],
    ['behind', false],
    ['diverged', false],
  ])('compare status %s → %s', async (status, expected) => {
    mockGithubApi.mockResolvedValue({ status });
    expect(await commitContains(42, 'org/repo', 'a', 'b')).toBe(expected);
  });

  it('is null with no installation or on API error', async () => {
    expect(await commitContains(undefined, 'org/repo', 'a', 'b')).toBeNull();
    mockGithubApi.mockRejectedValue(new Error('boom'));
    expect(await commitContains(42, 'org/repo', 'a', 'b')).toBeNull();
  });
});

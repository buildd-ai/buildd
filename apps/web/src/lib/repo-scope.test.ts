process.env.NODE_ENV = 'test';

import { describe, it, expect } from 'bun:test';
import {
  GITHUB_HOST_PREFIX_RE,
  GIT_SUFFIX_RE,
  prUrlFor,
  normalizeRepoFullName,
  repoFullNameFromPrUrl,
  resolvePrRepo,
} from './repo-scope';

/**
 * The regexes are executed by Postgres, not JS, so these tests exercise them
 * through the (compatible) JS regex engine to pin the behaviour that matters:
 * every stored form of a repo collapses to the same `owner/name`, and a
 * same-prefix repo does NOT collapse onto its neighbour.
 */
function normalize(repo: string | null): string {
  return (repo ?? '')
    .replace(new RegExp(GITHUB_HOST_PREFIX_RE), '')
    .replace(new RegExp(GIT_SUFFIX_RE), '')
    .toLowerCase();
}

describe('repo normalization', () => {
  const cases: Array<[string, string]> = [
    ['maxjacu/sibling-app', 'maxjacu/sibling-app'],
    ['https://github.com/maxjacu/sibling-app', 'maxjacu/sibling-app'],
    ['http://github.com/maxjacu/sibling-app', 'maxjacu/sibling-app'],
    ['https://www.github.com/maxjacu/sibling-app/', 'maxjacu/sibling-app'],
    ['https://github.com/maxjacu/sibling-app.git', 'maxjacu/sibling-app'],
    ['git@github.com:maxjacu/sibling-app.git', 'maxjacu/sibling-app'],
    ['ssh://git@github.com/maxjacu/sibling-app', 'maxjacu/sibling-app'],
    ['https://github.com/MaxJacu/Sibling-App', 'maxjacu/sibling-app'],
  ];

  for (const [input, expected] of cases) {
    it(`collapses ${input || '(empty)'} to ${expected}`, () => {
      expect(normalize(input)).toBe(expected);
    });
  }

  it('does not collapse a same-prefix repo onto its neighbour', () => {
    // Regression: the predicate this replaced was ilike '%owner/name%'.
    expect(normalize('https://github.com/maxjacu/sibling-app-legacy')).not.toBe('maxjacu/sibling-app');
    expect(normalize('https://github.com/maxjacu/sibling-app-legacy')).toBe('maxjacu/sibling-app-legacy');
  });

  it('normalizes null and empty repo to empty, which can never equal a full name', () => {
    expect(normalize(null)).toBe('');
    expect(normalize('')).toBe('');
  });

  it('leaves a non-github host alone rather than mangling it', () => {
    expect(normalize('https://gitlab.com/maxjacu/sibling-app')).toBe('https://gitlab.com/maxjacu/sibling-app');
  });
});

describe('prUrlFor', () => {
  it('builds the canonical prUrl workers store', () => {
    expect(prUrlFor('maxjacu/sibling-app', 146)).toBe('https://github.com/maxjacu/sibling-app/pull/146');
  });

  it('distinguishes the same PR number across repos', () => {
    // This is the whole point: buildd-ai/buildd#146 and maxjacu/sibling-app#146
    // both exist, and merging one used to stamp the other's worker.
    expect(prUrlFor('buildd-ai/buildd', 146)).not.toBe(prUrlFor('maxjacu/sibling-app', 146));
  });
});

/**
 * Regression: every GitHub API path in the reconcile tiers was built as
 * `/repos/${workspaces.repo}/...`. Because that column holds a URL for almost
 * every workspace, the request went to
 * `/repos/https://github.com/owner/name/pulls/N` and 404'd — every run, for
 * months, silently. These pin the JS-side normalization the sweeps now use.
 */
describe('normalizeRepoFullName', () => {
  it('collapses every stored form to a bare owner/name usable in an API path', () => {
    expect(normalizeRepoFullName('https://github.com/maxjacu/sibling-app')).toBe('maxjacu/sibling-app');
    expect(normalizeRepoFullName('git@github.com:maxjacu/sibling-app.git')).toBe('maxjacu/sibling-app');
    expect(normalizeRepoFullName('maxjacu/sibling-app')).toBe('maxjacu/sibling-app');
  });

  it('preserves case, unlike the SQL predicate — API paths are case-insensitive but URLs are not', () => {
    expect(normalizeRepoFullName('https://github.com/MaxJacu/Sibling-App')).toBe('MaxJacu/Sibling-App');
  });

  it('returns null for anything that is not exactly owner/name', () => {
    expect(normalizeRepoFullName(null)).toBeNull();
    expect(normalizeRepoFullName('')).toBeNull();
    expect(normalizeRepoFullName('   ')).toBeNull();
    // A bare owner with no repo would build `/repos/owner/pulls/N` — a
    // different, valid-looking endpoint. Must not be treated as a repo.
    expect(normalizeRepoFullName('maxjacu')).toBeNull();
    // Extra segments would inject path into the API URL.
    expect(normalizeRepoFullName('maxjacu/sibling-app/tree/dev')).toBeNull();
    // Non-github hosts cannot be reached through the GitHub App API.
    expect(normalizeRepoFullName('https://gitlab.com/maxjacu/sibling-app')).toBeNull();
  });
});

describe('repoFullNameFromPrUrl', () => {
  it('extracts the repo the PR actually lives in', () => {
    expect(repoFullNameFromPrUrl('https://github.com/maxjacu/sibling-app/pull/146'))
      .toBe('maxjacu/sibling-app');
  });

  it('rejects a compare/create URL, which carries no PR', () => {
    // Regression: a worker that never opened a PR stored
    // `.../pull/new/<branch>`. Treating that as a PR URL would send the sweep
    // hunting for a PR numbered after a branch name.
    expect(repoFullNameFromPrUrl('https://github.com/maxjacu/sibling-app/pull/new/feat/x')).toBeNull();
  });

  it('returns null for a non-PR url', () => {
    expect(repoFullNameFromPrUrl('https://github.com/maxjacu/sibling-app')).toBeNull();
    expect(repoFullNameFromPrUrl('')).toBeNull();
    expect(repoFullNameFromPrUrl(null)).toBeNull();
  });
});

describe('resolvePrRepo', () => {
  it('prefers the PR url over the workspace repo', () => {
    // Regression: workers routinely file PRs in a repo other than the one their
    // workspace points at (an iOS sibling, a family repo). Trusting the
    // workspace queried the wrong repo and stamped nothing.
    expect(resolvePrRepo({
      prUrl: 'https://github.com/buildd-ai/sibling-ios/pull/25',
      workspaceRepo: 'https://github.com/buildd-ai/primary',
    })).toBe('buildd-ai/sibling-ios');
  });

  it('falls back to the workspace repo when the PR url is unusable', () => {
    expect(resolvePrRepo({ prUrl: null, workspaceRepo: 'https://github.com/buildd-ai/primary' }))
      .toBe('buildd-ai/primary');
  });

  it('resolves from the PR url alone when the workspace has no repo', () => {
    // Regression: a coordination workspace with repo NULL/'' made every one of
    // its PRs permanently unreconcilable, even though each prUrl named a repo.
    expect(resolvePrRepo({ prUrl: 'https://github.com/buildd-ai/primary/pull/9', workspaceRepo: null }))
      .toBe('buildd-ai/primary');
    expect(resolvePrRepo({ prUrl: 'https://github.com/buildd-ai/primary/pull/9', workspaceRepo: '' }))
      .toBe('buildd-ai/primary');
  });

  it('returns null only when neither source yields a repo', () => {
    expect(resolvePrRepo({ prUrl: null, workspaceRepo: null })).toBeNull();
    expect(resolvePrRepo({ prUrl: '', workspaceRepo: '' })).toBeNull();
  });
});

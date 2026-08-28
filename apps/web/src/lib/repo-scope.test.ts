process.env.NODE_ENV = 'test';

import { describe, it, expect } from 'bun:test';
import {
  GITHUB_HOST_PREFIX_RE,
  GIT_SUFFIX_RE,
  prUrlFor,
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

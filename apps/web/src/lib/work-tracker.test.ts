import { describe, it, expect } from 'bun:test';
import { parseGitHubIssueUrl } from './work-tracker';

describe('parseGitHubIssueUrl', () => {
  it('parses a standard GitHub issue URL', () => {
    expect(parseGitHubIssueUrl('https://github.com/acme/widgets/issues/42')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 42,
    });
  });

  it('ignores trailing path/query segments', () => {
    expect(parseGitHubIssueUrl('https://github.com/acme/widgets/issues/7#issuecomment-1')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
    });
  });

  it('returns null for a pull-request URL (not an issue)', () => {
    expect(parseGitHubIssueUrl('https://github.com/acme/widgets/pull/42')).toBeNull();
  });

  it('returns null for a non-GitHub / Linear URL', () => {
    expect(parseGitHubIssueUrl('https://linear.app/acme/issue/ACM-42')).toBeNull();
  });

  it('returns null for null/empty input', () => {
    expect(parseGitHubIssueUrl(null)).toBeNull();
    expect(parseGitHubIssueUrl('')).toBeNull();
  });
});

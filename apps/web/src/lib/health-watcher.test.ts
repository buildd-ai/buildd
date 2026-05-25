import { describe, it, expect } from 'bun:test';
import { matchesFilter, filterFailingCheckRuns, dedupeKeyForPr } from './health-watcher';

describe('matchesFilter', () => {
  const pr = { labels: ['release', 'urgent'], title: 'release: v1.2.3' };

  it('returns true when filter is empty', () => {
    expect(matchesFilter(pr, {})).toBe(true);
  });

  it('matches when label is present', () => {
    expect(matchesFilter(pr, { label: 'release' })).toBe(true);
  });

  it('rejects when label is absent', () => {
    expect(matchesFilter(pr, { label: 'security' })).toBe(false);
  });

  it('matches when title prefix is satisfied', () => {
    expect(matchesFilter(pr, { titlePrefix: 'release:' })).toBe(true);
  });

  it('rejects when title prefix is not satisfied', () => {
    expect(matchesFilter(pr, { titlePrefix: 'feat:' })).toBe(false);
  });

  it('requires both label AND titlePrefix when both are set', () => {
    expect(matchesFilter(pr, { label: 'release', titlePrefix: 'release:' })).toBe(true);
    expect(matchesFilter(pr, { label: 'release', titlePrefix: 'feat:' })).toBe(false);
    expect(matchesFilter(pr, { label: 'missing', titlePrefix: 'release:' })).toBe(false);
  });
});

describe('filterFailingCheckRuns', () => {
  it('returns empty for an empty list', () => {
    expect(filterFailingCheckRuns([])).toEqual([]);
  });

  it('keeps completed runs with failure conclusion', () => {
    const result = filterFailingCheckRuns([
      { name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://x/1' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('lint');
    expect(result[0].conclusion).toBe('failure');
    expect(result[0].htmlUrl).toBe('https://x/1');
  });

  it('keeps timed_out and cancelled conclusions', () => {
    const result = filterFailingCheckRuns([
      { name: 'tests', status: 'completed', conclusion: 'timed_out' },
      { name: 'build', status: 'completed', conclusion: 'cancelled' },
    ]);
    expect(result.map((r) => r.name).sort()).toEqual(['build', 'tests']);
  });

  it('drops in-progress runs even if they have no conclusion yet', () => {
    expect(filterFailingCheckRuns([
      { name: 'flaky', status: 'in_progress', conclusion: null },
    ])).toEqual([]);
  });

  it('drops successful and neutral runs', () => {
    expect(filterFailingCheckRuns([
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: 'codecov', status: 'completed', conclusion: 'neutral' },
      { name: 'skipped', status: 'completed', conclusion: 'skipped' },
    ])).toEqual([]);
  });

  it('falls back to "unknown" when name is missing', () => {
    const result = filterFailingCheckRuns([
      { status: 'completed', conclusion: 'failure' },
    ]);
    expect(result[0].name).toBe('unknown');
  });
});

describe('dedupeKeyForPr', () => {
  it('combines PR number and head SHA', () => {
    expect(dedupeKeyForPr(42, 'abc123')).toBe('pr-42-abc123');
  });

  it('changes when the head SHA changes (new commits invalidate the lock)', () => {
    expect(dedupeKeyForPr(42, 'abc123')).not.toBe(dedupeKeyForPr(42, 'def456'));
  });
});

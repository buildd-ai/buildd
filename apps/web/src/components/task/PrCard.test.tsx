import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PrCard, { type PrOutcome } from './PrCard';

const outcome = (attempts: PrOutcome['attempts']): PrOutcome => ({
  repoLabel: 'acme/web',
  summary: 'Invoices render in customer currency.',
  totals: {
    add: attempts.reduce((s, a) => s + a.add, 0),
    rem: attempts.reduce((s, a) => s + a.rem, 0),
    files: 11,
    commits: 4,
    attempts: attempts.length,
    claimToMerge: null,
  },
  attempts,
  lineage: [],
  commits: [],
});

const render = (props: Partial<Parameters<typeof PrCard>[0]> = {}) =>
  renderToStaticMarkup(<PrCard prUrl="https://github.com/acme/web/pull/416" prNumber={416} {...props} />);

// Regression (demo reshoot, CI-retry step): the outcome card's primary button
// read "Review & merge" on a PR whose checks were red. Merging is not the next
// action there; reading the failing checks is.
describe('PrCard primary action on red CI', () => {
  it('offers the failing checks, not merge, when the stored lifecycle is ci_failed', () => {
    const html = render({ prLifecycleStatus: 'ci_failed', outcome: outcome([{ add: 402, rem: 61, files: 11 }]) });
    expect(html).not.toContain('Review &amp; merge');
    expect(html).toContain('View failing checks');
    expect(html).toContain('href="https://github.com/acme/web/pull/416/checks"');
  });

  it('offers the failing checks when GitHub reports a failed run, even before the lifecycle catches up', () => {
    const html = render({
      prLifecycleStatus: 'pr_open',
      ciChecks: { total: 2, passed: 1, failed: 1, pending: 0, runs: [] },
      outcome: outcome([{ add: 10, rem: 1, files: 1 }]),
    });
    expect(html).not.toContain('Review &amp; merge');
    expect(html).toContain('View failing checks');
  });

  it('the compact card follows the same rule', () => {
    const html = render({ prLifecycleStatus: 'ci_failed' });
    expect(html).not.toContain('Review &amp; merge');
    expect(html).toContain('View failing checks');
  });

  it('keeps Review & merge on a green open PR, and Open PR once merged', () => {
    expect(render({ prLifecycleStatus: 'pr_open', outcome: outcome([{ add: 1, rem: 0, files: 1 }]) })).toContain('Review &amp; merge');
    expect(render({ prLifecycleStatus: 'merged', outcome: outcome([{ add: 1, rem: 0, files: 1 }]) })).toContain('Open PR');
  });
});

// Regression: the diff bar laid out attempt 1's green and red, then attempt
// 2's, as one strip with the labels spread under it, so attempt 2's label sat
// under attempt 1's red removed-lines segment and red read as "attempt 2".
// Attempt identity and +/- colour are now separate: each attempt is its own
// group holding its own +/- segments and its own marker.
describe('PrCard diff bar', () => {
  const groups = (html: string) =>
    [...html.matchAll(/data-testid="pr-diff-attempt" data-attempt="(\d+)"[^>]*>([\s\S]*?)<\/div><div data-testid="pr-diff-attempt-marker"/g)]
      .map(m => ({ n: Number(m[1]), add: m[2].includes('data-sign="add"'), rem: m[2].includes('data-sign="rem"'), pending: m[2].includes('data-sign="pending"') }));

  it("draws each attempt as its own group with only its own +/- segments", () => {
    const html = render({ prLifecycleStatus: 'merged', outcome: outcome([{ add: 402, rem: 61, files: 11 }, { add: 23, rem: 9, files: 2 }]) });
    expect(groups(html)).toEqual([
      { n: 1, add: true, rem: true, pending: false },
      { n: 2, add: true, rem: true, pending: false },
    ]);
  });

  it('gives a running attempt with no lines yet its own placeholder group, not a neighbour\'s segment', () => {
    const html = render({ prLifecycleStatus: 'ci_failed', outcome: outcome([{ add: 402, rem: 61, files: 11 }, { add: 0, rem: 0, files: 0, running: true }]) });
    expect(groups(html)).toEqual([
      { n: 1, add: true, rem: true, pending: false },
      { n: 2, add: false, rem: false, pending: true },
    ]);
    expect(html).toContain('in progress');
  });
});

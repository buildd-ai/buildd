import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PrCard, { LineageChain, type PrOutcome } from './PrCard';

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

// Regression: the task page showed "Waiting on your merge" + "Review & merge"
// on a PR whose reviewer had requested changes and a fix was already queued —
// a merge the review-verdict gate was always going to refuse. The PR card
// must name the live fix task instead, on both the compact and outcome views.
describe('PrCard open fix attempt', () => {
  const openAttempt = { taskId: 'fix-1', title: '[reviewer retry #1] Fix flaky date parsing', status: 'pending', iteration: 1, maxIterations: 3, claimed: false };

  it('names the queued fix and drops the merge CTA on the compact card', () => {
    const html = render({ prLifecycleStatus: 'pr_open', openAttempt });
    expect(html).not.toContain('Review &amp; merge');
    expect(html).toContain('View PR');
    expect(html).toContain('Fix 1 of 3');
    expect(html).toContain('queued');
    expect(html).toContain('[reviewer retry #1] Fix flaky date parsing');
    expect(html).toContain('href="/app/tasks/fix-1"');
  });

  it('says "in progress" once a worker claims it', () => {
    const html = render({ prLifecycleStatus: 'pr_open', openAttempt: { ...openAttempt, claimed: true } });
    expect(html).toContain('in progress');
    expect(html).not.toContain('queued');
  });

  it('the outcome card names the fix too, and drops its primary action', () => {
    const html = render({
      prLifecycleStatus: 'pr_open',
      openAttempt,
      outcome: outcome([{ add: 10, rem: 1, files: 1 }]),
    });
    expect(html).not.toContain('Review &amp; merge');
    expect(html).toContain('Fix 1 of 3');
    expect(html).toContain('[reviewer retry #1] Fix flaky date parsing');
  });

  it('never shows on a merged PR', () => {
    const html = render({ prLifecycleStatus: 'merged', openAttempt });
    expect(html).not.toContain('Fix 1 of 3');
    expect(html).toContain('View PR');
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

// Regression (demo reshoot, PR history): the CI-failed step broke a file name
// mid-word ("invoice.snapshot.t / est.tsx") under overflow-wrap:anywhere.
describe('LineageChain step text wraps at path boundaries only', () => {
  const html = renderToStaticMarkup(
    <LineageChain steps={[{ kind: 'ci_failed', title: 'CI failed', sub: 'unit · packages/pdf/invoice.snapshot.test.tsx', at: null }]} />,
  );
  it('offers a break after every "/" and "." and nowhere else', () => {
    expect(html).toContain('packages/<wbr/>pdf/<wbr/>invoice.<wbr/>snapshot.<wbr/>test.<wbr/>tsx');
  });
  it('does not let the browser break anywhere mid-word', () => {
    expect(html).not.toContain('overflow-wrap:anywhere');
  });
});

// The completed task page's "What shipped" header owns the one action; the PR
// card beneath it must not offer a second, side-by-side one.
describe('PrCard under the What shipped header', () => {
  it('hides its own action when the header carries it', () => {
    const html = render({ prLifecycleStatus: 'pr_open', outcome: outcome([{ add: 1, rem: 0, files: 1 }]), hideAction: true });
    expect(html).not.toContain('data-testid="pr-outcome-action"');
  });
  it('stacks the summary above the action below md', () => {
    const html = render({ prLifecycleStatus: 'pr_open', outcome: outcome([{ add: 1, rem: 0, files: 1 }]) });
    expect(html).toContain('flex flex-col md:flex-row');
  });
});

describe('Checks inside the PR history', () => {
  const pass = (name: string) => ({ name, status: 'completed', conclusion: 'success', detailsUrl: null });
  const withCommits = (commits: PrOutcome['commits']) => ({ ...outcome([{ add: 1, rem: 0, files: 1 }]), commits });

  it('collapses an all-green attempt to one row, inside PR history (no separate checks section)', () => {
    const html = render({
      prLifecycleStatus: 'ci_green',
      outcome: withCommits([{ attempt: 1, sha: '69786bc', state: 'passed', failure: null, runs: Array.from({ length: 9 }, (_, i) => pass(`check ${i}`)) }]),
    });
    expect(html).toContain('data-testid="pr-commit-checks-mobile"');
    expect(html).toContain('Attempt 1</span> · <span class="text-text-primary">69786bc</span>');
    expect(html).toContain('✓ 9 checks passed');
    expect(html).toContain('data-open="false"');
    // Collapsed: no rows mounted, and one timeline at every width.
    expect(html).not.toContain('data-testid="pr-check-row"');
    expect(html).not.toContain('data-testid="pr-commit-checks"');
    expect(html).not.toContain('Checks by commit');
    expect(html.indexOf('data-testid="pr-history"')).toBeLessThan(html.indexOf('data-testid="pr-commit-checks-mobile"'));
  });

  it('opens a failed attempt as full-width rows, failure first, linking its log', () => {
    const html = render({
      prLifecycleStatus: 'ci_failed',
      outcome: withCommits([{
        attempt: 1, sha: '69786bc', state: 'failed', failure: null,
        runs: [pass('lint'), { name: 'unit', status: 'completed', conclusion: 'failure', detailsUrl: 'https://ci/unit' }],
      }]),
    });
    expect(html).toContain('data-open="true"');
    const rows = [...html.matchAll(/data-testid="pr-check-row" data-outcome="(\w+)"/g)].map(m => m[1]);
    expect(rows).toEqual(['failed', 'passed']);
    expect(html).toContain('href="https://ci/unit"');
    expect(html).toContain('min-h-11');
  });
});

describe('a no-diff attempt', () => {
  it('says what it did instead of "+0 −0 · 0 files"', () => {
    const html = render({
      prLifecycleStatus: 'ci_failed',
      outcome: { ...outcome([{ add: 5, rem: 1, files: 2 }, { add: 0, rem: 0, files: 0, actions: ['Edited PR body'] }]) },
    });
    expect(html).toContain('Attempt 2 (fix) · Edited PR body');
    expect(html).not.toContain('Attempt 2 (fix) · +0 −0 · 0 files');
  });
});

describe('PrCard primary action when the PR cannot merge yet', () => {
  const o = outcome([{ add: 10, rem: 1, files: 1 }]);
  it('does not offer Review & merge on an unmergeable PR', () => {
    const html = render({ prLifecycleStatus: 'pr_open', mergeable: false, mergeableState: 'dirty', outcome: o });
    expect(html).not.toContain('Review &amp; merge');
    expect(html).toContain('View PR');
  });
  it('does not offer Review & merge while CI is pending', () => {
    const html = render({ prLifecycleStatus: 'pr_open', ciChecks: { total: 2, passed: 1, failed: 0, pending: 1, runs: [] }, outcome: o });
    expect(html).not.toContain('Review &amp; merge');
  });
});

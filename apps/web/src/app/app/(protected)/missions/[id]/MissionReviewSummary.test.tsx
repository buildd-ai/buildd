/**
 * The outcome summary counts PRs, not the tasks that carry them.
 *
 * A CI-retry task (`[builder · after CI #1] …`) pushes to its parent's PR, so
 * two task rows name one PR. Counted per row, the summary claimed a merge that
 * never happened twice and listed the PR twice.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionReviewSummary, { type ReviewSummaryTask } from './MissionReviewSummary';

const url = (n: number) => `https://github.example/org/repo/pull/${n}`;

function row(over: Partial<ReviewSummaryTask>): ReviewSummaryTask {
  return {
    id: 't',
    title: 'Do the work',
    status: 'completed',
    prUrl: null,
    prNumber: null,
    prMerged: false,
    prClosed: false,
    ...over,
  };
}

const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('MissionReviewSummary — PRs counted by identity', () => {
  it('a parent and its CI retry sharing one merged PR read as one merged PR', () => {
    const html = renderToStaticMarkup(
      <MissionReviewSummary
        missionId="m-1"
        tasks={[
          row({ id: 'parent', title: 'Do the work', prUrl: url(5), prNumber: 5, prMerged: true }),
          // The retry's own worker row may not carry mergedAt — the PR merged
          // all the same, and it is the same PR.
          row({ id: 'retry', title: '[builder · after CI #1] Do the work', prUrl: url(5), prNumber: 5, prMerged: false }),
          row({ id: 'other', title: 'Other work', prUrl: url(6), prNumber: 6, prMerged: true }),
        ]}
      />,
    );
    expect(text(html)).toContain('2 merged');
    expect(text(html)).not.toContain('open');
    expect(text(html)).not.toContain('not yet merged');
    expect(html.match(/href="https:\/\/github\.example\/org\/repo\/pull\/5"/g)?.length).toBe(1);
  });

  it('still counts two distinct open PRs as two', () => {
    const html = renderToStaticMarkup(
      <MissionReviewSummary
        missionId="m-1"
        tasks={[
          row({ id: 'a', prUrl: url(1), prNumber: 1 }),
          row({ id: 'b', prUrl: url(2), prNumber: 2 }),
        ]}
      />,
    );
    expect(text(html)).toContain('0 merged · 2 open');
    expect(text(html)).toContain('2 PRs not yet merged');
  });
});

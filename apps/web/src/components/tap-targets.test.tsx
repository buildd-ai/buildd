import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskCard, type TaskCardProps } from './TaskCard';
import PrCard from './task/PrCard';
import StatRow from '@/app/app/(protected)/tasks/[id]/StatRow';

// Regression (U1 visual audit, task 2ae639ce): stand-alone links under 44px
// at 320px. The layout gate (scripts/qa/steps.ts) measures the element's own
// box, so a pseudo-element hit area does not count; the box itself must reach
// 44px below md, with negative margins handing the extra back to the row.

/** The class list of the first `tag` whose attributes contain `marker`. */
function classesOf(html: string, tag: string, marker: string): string[] {
  const open = html.match(new RegExp(`<${tag}\\b[^>]*${marker}[^>]*>`))?.[0];
  if (!open) throw new Error(`no <${tag}> with ${marker}`);
  return (open.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);
}

const card = (overrides: Partial<TaskCardProps>): TaskCardProps => ({
  id: 'task-1',
  title: 'Do the thing',
  taskStatus: 'running',
  taskCreatedAt: '2026-08-01T00:00:00.000Z',
  taskUpdatedAt: '2026-08-01T00:00:00.000Z',
  density: 'row',
  prUrl: 'https://github.com/acme/web/pull/42',
  prNumber: 42,
  ...overrides,
});

function expectTapBox(cls: string[]) {
  expect(cls).toContain('max-md:min-h-11');
  expect(cls).toContain('max-md:inline-flex');
  expect(cls).toContain('max-md:items-center');
  expect(cls.some((c) => c.startsWith('max-md:-my-'))).toBe(true);
}

describe('stand-alone links are 44px to touch below md', () => {
  it('the running worker PR link is its whole stat tile', () => {
    const html = renderToStaticMarkup(
      <StatRow elapsed="3m" turns={4} tokens={null} pr={{ url: 'https://github.com/acme/web/pull/42', number: 42, state: 'open' }} filesTouched={0} added={null} removed={null} />,
    );
    // The whole tile is the link: a box inside the tile's truncating value
    // line would be clipped back to the line's height for touch.
    const cls = classesOf(html, 'a', 'data-testid="worker-pr-link"');
    // Wide padding follows the row's own width (StatRow sits in the mission sheet too).
    expect(cls).toEqual(expect.arrayContaining(['block', '-mx-3', '-my-2.5', 'px-3', 'py-2.5', '@xl:-mx-4', '@xl:-my-3', '@xl:px-4', '@xl:py-3']));
    expect(classesOf(html, 'div', 'data-testid="worker-stat-pr"')).toEqual(expect.arrayContaining(['px-3', 'py-2.5', '@xl:px-4', '@xl:py-3']));
  });

  it('the PR number on the outcome card, widened to 44px too', () => {
    const html = renderToStaticMarkup(
      <PrCard
        prUrl="https://github.com/acme/web/pull/416"
        prNumber={416}
        outcome={{ repoLabel: 'acme/web', summary: 'x', totals: { add: 1, rem: 0, files: 1, commits: 1, attempts: 1, claimToMerge: null }, attempts: [{ add: 1, rem: 0, files: 1 }], lineage: [], commits: [] }}
      />,
    );
    const cls = classesOf(html, 'a', 'data-testid="pr-outcome-number"');
    expectTapBox(cls);
    expect(cls.some((c) => c.startsWith('max-md:-mx-'))).toBe(true);
  });

  // Rows sit flush, so the box may reach down only as far as the row's own
  // bottom padding: past it, a tap on the next row would open this PR.
  for (const [density, pad] of [['row', '2.5'], ['full', '3']] as const) {
    it(`the Open PR link on a ${density} card is a real box that stops at the row's bottom padding`, () => {
      const html = renderToStaticMarkup(<TaskCard {...card({ density })} />);
      const cls = classesOf(html, 'a', 'aria-label="Open PR #42"');
      expect(cls).toContain('max-md:min-h-11');
      expect(cls).toContain('max-md:inline-flex');
      expect(cls).toContain(`max-md:-mb-${pad}`);
      expect(cls).toContain(`max-md:pb-${pad}`);
      expect(cls.some((c) => c.startsWith('max-md:-mx-'))).toBe(true);
      expect(cls.some((c) => c.includes('after:'))).toBe(false);
      const root = classesOf(html, 'div', 'data-testid="task-card"');
      expect(root).toContain(`py-${pad}`);
    });
  }
});

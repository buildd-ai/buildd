import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/app/health/insights/tasks',
  useSearchParams: () => new URLSearchParams(),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: TaskGrid, BAND_ROW_PAGE } = await import('../../../tasks/TaskGrid');
const { sampleBandSelection } = await import('./sample-band');
const { displayTaskTitle } = await import('@/lib/task-title');

const now = Date.UTC(2026, 9, 6, 12);
const render = (state: 'sample' | 'large') => {
  const s = sampleBandSelection(state, undefined, now);
  return { s, html: renderToStaticMarkup(<TaskGrid key={s.label} bandFilterLabel={s.label} tasks={s.tasks} workspaces={[]} />) };
};
/** Fixture titles end in a unique `(n)`, so a display title present in the markup is a rendered row. */
const shownRows = (html: string, titles: string[]) => titles.filter(t => html.includes(`${displayTaskTitle(t)}<`)).length;

describe('band drill-down fixture renders through the real TaskGrid', () => {
  for (const state of ['sample', 'large'] as const) {
    it(`${state}: populated list with the selection label, not the empty state`, () => {
      const { html } = render(state);
      expect(html).toContain('data-testid="task-band-filter"');
      expect(html).not.toContain('data-testid="task-band-empty"');
      expect(html).toContain('Clear band filter');
    });
  }

  it('sample: every row renders, the total is shown, no show-more', () => {
    const { s, html } = render('sample');
    expect(shownRows(html, s.tasks.map(t => t.title))).toBe(s.tasks.length);
    expect(html).toContain(`${s.tasks.length} tasks`);
    expect(html).not.toContain('data-testid="task-band-show-more"');
  });

  it('large: caps the rows, states the total, and offers show more', () => {
    const { s, html } = render('large');
    expect(s.tasks.length).toBeGreaterThan(BAND_ROW_PAGE);
    expect(shownRows(html, s.tasks.map(t => t.title))).toBe(BAND_ROW_PAGE);
    expect(html).toContain('data-testid="task-band-total"');
    expect(html).toContain(`${s.tasks.length} tasks`);
    expect(html).toContain(`Showing ${BAND_ROW_PAGE} of ${s.tasks.length}`);
    expect(html).toContain('data-testid="task-band-show-more"');
  });
});

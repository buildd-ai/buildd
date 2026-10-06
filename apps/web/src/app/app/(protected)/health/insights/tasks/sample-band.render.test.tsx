import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/app/health/insights/tasks',
  useSearchParams: () => new URLSearchParams(),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: TaskGrid } = await import('../../../tasks/TaskGrid');
const { sampleBandSelection } = await import('./sample-band');

describe('band drill-down fixture renders through the real TaskGrid', () => {
  for (const state of ['sample', 'large'] as const) {
    it(`${state}: populated list with the selection label, not the empty state`, () => {
      const s = sampleBandSelection(state, undefined, Date.UTC(2026, 9, 6, 12));
      const html = renderToStaticMarkup(<TaskGrid key={s.label} bandFilterLabel={s.label} tasks={s.tasks} workspaces={[]} />);
      expect(html).toContain('data-testid="task-band-filter"');
      expect(html).not.toContain('data-testid="task-band-empty"');
      expect(html).toContain(s.tasks[0].title);
    });
  }
});

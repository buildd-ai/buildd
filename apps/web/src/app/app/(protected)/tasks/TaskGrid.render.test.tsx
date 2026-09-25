import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/app/tasks',
  useSearchParams: () => new URLSearchParams(),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: TaskGrid } = await import('./TaskGrid');

describe('TaskGrid — empty Activity', () => {
  // The only action used to be "New Mission"; a one-off task had no way in
  // from the page that lists tasks.
  it('offers a "New task" action next to "New Mission"', () => {
    const html = renderToStaticMarkup(<TaskGrid tasks={[]} missionFilter={null} missionTitle={null} />);
    expect(html).toContain('No activity yet');
    expect(html).toContain('href="/app/missions/new"');
    expect(html).toMatch(/data-testid="activity-empty-new-task"[^>]*>New task</);
    expect(html).toContain('href="/app/tasks/new"');
  });
});

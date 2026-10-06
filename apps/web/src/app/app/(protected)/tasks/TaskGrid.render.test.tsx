import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/app/tasks',
  useSearchParams: () => new URLSearchParams(),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: TaskGrid } = await import('./TaskGrid');
const { ChatEntryProvider } = await import('@/components/chat/ChatEntry');

describe('TaskGrid — empty Activity', () => {
  // The only action used to be "New Mission"; a one-off task had no way in
  // from the page that lists tasks.
  it('offers a "New task" action next to "New Mission"', () => {
    const html = renderToStaticMarkup(<TaskGrid tasks={[]} missionFilter={null} missionTitle={null} />);
    expect(html).toContain('No activity');
    expect(html).toContain('href="/app/missions/new"');
    expect(html).toMatch(/data-testid="activity-empty-new-task"[^>]*>New task</);
    expect(html).toContain('href="/app/tasks/new"');
  });
});

describe('TaskGrid — empty Activity with chat available', () => {
  it('New Mission and New task open chat instead of the forms', () => {
    const html = renderToStaticMarkup(
      <ChatEntryProvider value={{ available: true, teamId: 't', setupHref: null }}>
        <TaskGrid tasks={[]} missionFilter={null} missionTitle={null} />
      </ChatEntryProvider>,
    );
    expect(html).toContain('href="/app/chat?new=mission"');
    expect(html).toContain('href="/app/chat?new=task"');
    expect(html).not.toContain('href="/app/tasks/new"');
  });
});

it('keeps the selected historical band visible even when its task list is empty', () => {
  const html = renderToStaticMarkup(<TaskGrid tasks={[]} bandFilterLabel="Released · Jan 10" />);
  expect(html).toContain('Released · Jan 10');
  expect(html).toContain('Clear band filter');
});

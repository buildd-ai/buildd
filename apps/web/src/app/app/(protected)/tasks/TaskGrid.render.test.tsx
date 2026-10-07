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

describe('TaskGrid — empty band drill-down', () => {
  const html = renderToStaticMarkup(<TaskGrid tasks={[]} bandFilterLabel="Released · Jan 10" />);

  it('says the band was empty instead of the generic "No activity" state', () => {
    expect(html).toContain('data-testid="task-band-empty"');
    expect(html).toContain('No tasks in this band');
    expect(html).not.toContain('No activity');
  });

  it('offers Clear band filter as the primary action, not the new-work CTAs', () => {
    expect(html).toMatch(/data-testid="task-band-empty-clear"[^>]*href="\/app\/tasks"|href="\/app\/tasks"[^>]*data-testid="task-band-empty-clear"/);
    expect(html).not.toContain('New Mission');
    expect(html).not.toContain('activity-empty-new-task');
  });

  it('renders a page heading at every width and centers the band label', () => {
    expect(html).toMatch(/<h1[^>]*>Activity<\/h1>/);
    expect(html).not.toMatch(/<h1[^>]*hidden md:block/);
    expect(html).not.toContain('data-testid="task-band-filter"');
  });
});

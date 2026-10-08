import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/app/tasks',
  useSearchParams: () => new URLSearchParams(),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: InteractiveSessions } = await import('./InteractiveSessions');
const { default: TaskGrid } = await import('./TaskGrid');
type View = import('@/lib/local-session-view').LocalSessionView;

const NOW = Date.parse('2026-10-07T12:00:00Z');
const view = (over: Partial<View>): View => ({
  id: 'p1', workspaceId: 'ws', client: 'claude', clientLabel: 'Claude Code', clientVersion: null, repo: 'acme/app',
  interactive: true, state: 'online', startedAt: '2026-10-07T11:00:00Z', lastSeenAt: '2026-10-07T11:58:00Z',
  endedAt: null, task: null, workerId: null, workerLive: false, tasks: [], ...over,
});

describe('InteractiveSessions', () => {
  it('renders nothing without sessions', () => {
    expect(renderToStaticMarkup(<InteractiveSessions sessions={[]} now={NOW} />)).toBe('');
  });

  it('titles the count "Interactive sessions" and counts only online ones', () => {
    const html = renderToStaticMarkup(
      <InteractiveSessions now={NOW} sessions={[
        view({ id: 'a', state: 'bound', task: { id: 't1', title: 'Fix login', status: 'in_progress' }, workerLive: true, tasks: [{ id: 't1', title: 'Fix login', status: 'in_progress', workerId: 'w1', live: true }] }),
        view({ id: 'b', client: 'cursor', clientLabel: 'Cursor', state: 'online' }),
        view({ id: 'c', client: 'codex', clientLabel: 'Codex', state: 'ended', endedAt: '2026-10-07T10:00:00Z' }),
      ]} />,
    );
    expect(html).toContain('Interactive sessions');
    expect(html).toMatch(/Interactive sessions<span[^>]*>2</);
    expect(html).not.toMatch(/agents?/i);
  });

  it('a working session names its client, links its task, and says buildd cannot close it', () => {
    const html = renderToStaticMarkup(
      <InteractiveSessions now={NOW} sessions={[view({ state: 'bound', task: { id: 't1', title: 'Fix login', status: 'in_progress' }, workerLive: true, tasks: [{ id: 't1', title: 'Fix login', status: 'in_progress', workerId: 'w1', live: true }] })]} />,
    );
    expect(html).toContain('Claude Code');
    expect(html).toContain('Working');
    expect(html).toContain('href="/app/tasks/t1"');
    expect(html).toContain('Buildd can release its slot, not close it.');
    // Runtime is a muted badge, never a task-state colour.
    expect(html).toContain('data-tone="muted"');
    expect(html).not.toContain('—');
  });

  it('a finished task no longer claims a slot line', () => {
    const html = renderToStaticMarkup(
      <InteractiveSessions now={NOW} sessions={[view({ state: 'ended', endedAt: '2026-10-07T11:59:00Z', task: { id: 't1', title: 'Fix login', status: 'completed' }, workerLive: false, tasks: [{ id: 't1', title: 'Fix login', status: 'completed', workerId: 'w1', live: false }] })]} />,
    );
    expect(html).toContain('Ended');
    expect(html).not.toContain('release its slot');
  });

  it('a session holding several tasks lists each of them, with one slot line', () => {
    const html = renderToStaticMarkup(
      <InteractiveSessions now={NOW} sessions={[view({
        state: 'bound', workerLive: true, task: { id: 't2', title: 'Add export', status: 'in_progress' }, workerId: 'w2',
        tasks: [
          { id: 't1', title: 'Fix login', status: 'completed', workerId: 'w1', live: false },
          { id: 't2', title: 'Add export', status: 'in_progress', workerId: 'w2', live: true },
        ],
      })]} />,
    );
    expect(html).toContain('href="/app/tasks/t1"');
    expect(html).toContain('href="/app/tasks/t2"');
    expect(html.match(/release its slot/g)).toHaveLength(1);
  });

  it('shows on Activity, including when there are no tasks', () => {
    const html = renderToStaticMarkup(<TaskGrid tasks={[]} missionFilter={null} missionTitle={null} localSessions={[view({})]} />);
    expect(html).toContain('data-testid="interactive-sessions"');
    expect(html).toContain('No activity');
  });
});

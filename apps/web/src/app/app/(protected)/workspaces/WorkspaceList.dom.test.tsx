/**
 * /app/workspaces moves a workspace through the same dialog as Settings →
 * Workspaces: "Move to team…" opens it, picking a team runs the precheck, and
 * Move runs /migrate/execute. The old "Move to:" select (a bare PATCH of
 * teamId behind a confirm) is gone. After a move a toast links to the
 * workspace in its new team.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/workspaces' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = mock(() => {});
mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/workspaces',
}));
const openInTeam = mock((_teamId: string, _href: string) => {});
mock.module('@/lib/switch-team', () => ({ openInTeam, switchTeam: () => {} }));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: WorkspaceList } = await import('./WorkspaceList');
type Props = Parameters<typeof WorkspaceList>[0];

// Illustrative fixtures only.
const ws = (id: string, name: string, canMove: boolean) => ({
  id, name, repo: null, localPath: null, createdAt: new Date('2026-01-01T00:00:00Z'),
  teamId: 'team-a', teamName: 'Team A', canMove,
  runners: { service: false, user: false },
});
const props: Props = {
  workspaces: [ws('ws-1', 'Example Workspace', true), ws('ws-2', 'Read Only Workspace', false)],
  moveTeams: [{ id: 'team-a', name: 'Team A' }, { id: 'team-b', name: 'Team B' }],
};

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof mock>;
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  fetchMock = mock(async (url: string) => {
    if (url.endsWith('/migrate/precheck')) {
      return json({
        report: {
          sourceTeamName: 'Team A', destinationTeamName: 'Team B',
          precheck: { status: 'PASS', githubApp: { ok: true } },
          groups: [], requiredAcks: [],
        },
        dryRunToken: 'tok',
      });
    }
    if (url.endsWith('/migrate/execute')) return json({ outcomes: [] });
    return json({}, 404);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
  refresh.mockClear();
  openInTeam.mockClear();
});

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
}

function rowOf(name: string): HTMLElement {
  const row = [...container.querySelectorAll('[data-testid="workspace-list-row"]')]
    .find(r => r.textContent?.includes(name));
  expect(row).toBeDefined();
  return row as HTMLElement;
}

describe('WorkspaceList move-to-team', () => {
  it('has no "Move to:" select; offers Move to team… only where the user can move', async () => {
    await act(async () => root.render(<WorkspaceList {...props} />));
    expect(container.textContent).not.toContain('Move to:');
    expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();
    const move = (name: string) => [...rowOf(name).querySelectorAll('button')].find(b => b.textContent?.trim() === 'Move to team…');
    expect(move('Example Workspace')).toBeDefined();
    expect(move('Read Only Workspace')).toBeUndefined();
  });

  it('moves through the checked flow and links to the workspace in its new team', async () => {
    await act(async () => root.render(<WorkspaceList {...props} />));
    const open = [...rowOf('Example Workspace').querySelectorAll('button')].find(b => b.textContent?.trim() === 'Move to team…')!;
    await act(async () => { open.click(); });

    // One destination: the check ran as the dialog opened.
    const urls = () => fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls()).toEqual(['/api/workspaces/ws-1/migrate/precheck']);

    await act(async () => { buttonByText('Move')!.click(); });
    expect(urls()).toEqual(['/api/workspaces/ws-1/migrate/precheck', '/api/workspaces/ws-1/migrate/execute']);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(false);

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const toast = document.querySelector('[data-testid="move-toast"]') as HTMLElement;
    expect(toast.textContent).toContain('Moved Example Workspace to Team B');
    const link = toast.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/app/workspaces/ws-1');
    await act(async () => { link.click(); });
    expect(openInTeam).toHaveBeenCalledWith('team-b', '/app/workspaces/ws-1');
  });

  it('keeps the toast when the move empties the list', async () => {
    const only: Props = { ...props, workspaces: [props.workspaces[0]] };
    await act(async () => root.render(<WorkspaceList {...only} />));
    const open = [...rowOf('Example Workspace').querySelectorAll('button')].find(b => b.textContent?.trim() === 'Move to team…')!;
    await act(async () => { open.click(); });
    await act(async () => { buttonByText('Move')!.click(); });
    // router.refresh(): the moved workspace left the active team.
    await act(async () => root.render(<WorkspaceList {...only} workspaces={[]} />));
    expect(container.textContent).toContain('No workspaces');
    expect(document.querySelector('[data-testid="move-toast"]')?.textContent).toContain('Moved Example Workspace to Team B');
  });
});

describe('runner markers', () => {
  it('shows no unexplained crosses for a workspace with no runner yet', () => {
    act(() => root.render(<WorkspaceList {...props} />));
    const text = container.textContent ?? '';
    expect(text).not.toContain('Service');
    expect(text).not.toContain('GH Action');
    expect(container.querySelector('[data-testid="workspace-runner-marker"]')).toBeNull();
  });

  it('names a connected runner in plain words and explains it on hover', () => {
    const withRunner = { ...ws('ws-3', 'Busy Workspace', false), runners: { service: true, user: false } };
    act(() => root.render(<WorkspaceList workspaces={[withRunner]} moveTeams={[]} />));
    const markers = [...container.querySelectorAll('[data-testid="workspace-runner-marker"]')];
    expect(markers.map((m) => m.textContent)).toEqual(['Server runner']);
    expect(markers[0].getAttribute('title')).toMatch(/always-on server/);
  });
});


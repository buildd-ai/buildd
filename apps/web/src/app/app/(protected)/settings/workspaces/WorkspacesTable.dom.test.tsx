/**
 * Settings → Workspaces as one table: a row per workspace with its team, git
 * workflow and merge policy links, an inline "Require green CI" switch that
 * PATCHes the workspace, and a row menu holding "Move to team…" only where a
 * move is possible. Fixtures are illustrative.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspaces', width: 1280, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/settings/workspaces',
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: WorkspacesTable } = await import('./WorkspacesTable');
type Row = Parameters<typeof WorkspacesTable>[0]['rows'][number];

const ROWS: Row[] = [
  {
    id: 'ws-1', name: 'example-app', teamId: 'team-a', teamName: 'Team A',
    gitWorkflow: 'Mission branch', mergePolicy: 'Auto-threshold', enforceGreenCI: false,
    canEdit: true, canMove: true,
  },
  {
    id: 'ws-2', name: 'example-api', teamId: 'team-b', teamName: 'Team B',
    gitWorkflow: 'Direct', mergePolicy: 'Human gate', enforceGreenCI: true,
    canEdit: true, canMove: true,
  },
  {
    id: 'ws-3', name: 'example-docs', teamId: 'team-c', teamName: 'Team C',
    gitWorkflow: 'Direct', mergePolicy: 'Agent review', enforceGreenCI: false,
    canEdit: false, canMove: false,
  },
];
const TEAMS = [{ id: 'team-a', name: 'Team A' }, { id: 'team-b', name: 'Team B' }];

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof mock>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = mock(async () => new Response('{}', { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

function render(rows: Row[] = ROWS) {
  act(() => root.render(<WorkspacesTable rows={rows} moveTeams={TEAMS} />));
}

function rows() {
  return [...host.querySelectorAll('[data-testid="workspace-row"]')] as HTMLElement[];
}

function ciSwitch(row: HTMLElement) {
  return row.querySelector('[role="switch"]') as HTMLButtonElement;
}

describe('WorkspacesTable', () => {
  it('renders one row per workspace with team, workflow and policy', () => {
    render();
    expect(rows()).toHaveLength(3);
    const first = rows()[0];
    expect(first.textContent).toContain('example-app');
    expect(first.textContent).toContain('Team A');
    const links = [...first.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toContainEqual(['Mission branch', '/app/workspaces/ws-1/config']);
    expect(links).toContainEqual(['Auto-threshold', '/app/settings/workspace/ws-1']);
  });

  it('shows each row\'s current CI requirement', () => {
    render();
    expect(rows().map((r) => ciSwitch(r).getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  });

  it('the CI switch PATCHes that workspace\'s gitConfig', async () => {
    render();
    await act(async () => { ciSwitch(rows()[0]).click(); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspaces/ws-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ gitConfig: { enforceGreenCI: true } });
    expect(ciSwitch(rows()[0]).getAttribute('aria-checked')).toBe('true');
  });

  it('rolls the switch back when the save fails', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
    render();
    await act(async () => { ciSwitch(rows()[1]).click(); });
    expect(ciSwitch(rows()[1]).getAttribute('aria-checked')).toBe('true');
    expect(rows()[1].textContent).toContain('Forbidden');
  });

  it('disables the switch where the user cannot edit', () => {
    render();
    expect(ciSwitch(rows()[2]).disabled).toBe(true);
  });

  it('puts Move to team… in the row menu only where a move is possible', async () => {
    render();
    expect(rows()[2].querySelector('[data-testid="workspace-row-menu"]')).toBeNull();

    const trigger = rows()[0].querySelector('[data-testid="workspace-row-menu"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { trigger.click(); });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const move = [...rows()[0].querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Move to team…');
    expect(move).toBeDefined();
    await act(async () => { move!.click(); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('example-app');
  });

  it('moves from the row menu with the check run for you, then links to the workspace in its new team', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/migrate/precheck')) {
        return new Response(JSON.stringify({
          report: {
            sourceTeamName: 'Team A', destinationTeamName: 'Team B',
            precheck: { status: 'PASS', githubApp: { ok: true } },
            groups: [{
              entity: 'Connectors', disposition: 'NEEDS_RE_AUTH', count: 1,
              items: [{ key: 'connector:c1', label: 'x', disposition: 'NEEDS_RE_AUTH' }],
            }],
            requiredAcks: ['connector:c1'],
          },
          dryRunToken: 'tok',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ outcomes: [] }), { status: 200 });
    });
    render();
    const trigger = rows()[0].querySelector('[data-testid="workspace-row-menu"]') as HTMLButtonElement;
    await act(async () => { trigger.click(); });
    const open = [...rows()[0].querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Move to team…')!;
    await act(async () => { open.click(); });

    expect(document.querySelector('[data-testid="move-consequences"]')?.textContent).toBe('1 connector needs reconnecting');
    const move = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Move')!;
    await act(async () => { move.click(); });

    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([
      '/api/workspaces/ws-1/migrate/precheck',
      '/api/workspaces/ws-1/migrate/execute',
    ]);
    const toast = document.querySelector('[data-testid="move-toast"]');
    expect(toast?.textContent).toContain('Moved example-app to Team B');
    expect(toast?.querySelector('a')?.getAttribute('href')).toBe('/app/workspaces/ws-1');
  });
});

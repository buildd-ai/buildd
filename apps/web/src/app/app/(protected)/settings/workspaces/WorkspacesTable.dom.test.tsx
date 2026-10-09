/**
 * Settings → Workspaces as a list: the defaults once, a row per workspace with
 * only what differs (as chips linking to the editor), where work runs, last
 * task, open tasks and health; team headings only across teams; inactive rows
 * folded; no policy toggle in the list. Fixtures are illustrative.
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

const NOW = '2026-06-01T12:00:00.000Z';
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
const DEFAULTS = { gitWorkflow: 'Mission branch', mergePolicy: 'Auto-threshold' };

const base = (over: Partial<Row>): Row => ({
  id: 'ws', name: 'ws', teamId: 'team-a', teamName: 'Team A', differs: [],
  runsOn: { executor: 'any', size: null }, lastActivityAt: daysAgo(1), openTasks: 0,
  health: { stuckTasks: 0, redPrs: 0 }, canEdit: true, canMove: true, ...over,
});

const ROWS: Row[] = [
  base({ id: 'ws-1', name: 'example-app', lastActivityAt: daysAgo(2), openTasks: 3, runsOn: { executor: 'cloud', size: 'large' } }),
  base({
    id: 'ws-2', name: 'example-api', lastActivityAt: daysAgo(1),
    differs: [{ key: 'mergePolicy', label: 'Agent review', href: '/app/settings/workspace/ws-2' }],
    health: { stuckTasks: 2, redPrs: 1 },
  }),
  base({ id: 'ws-3', name: 'example-sandbox', lastActivityAt: daysAgo(90), canMove: false }),
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
  act(() => root.render(<WorkspacesTable rows={rows} moveTeams={TEAMS} defaults={DEFAULTS} now={NOW} />));
}

function rows() {
  return [...host.querySelectorAll('[data-testid="workspace-row"]')] as HTMLElement[];
}

describe('WorkspacesTable', () => {
  it('states the defaults once and lists active rows by last activity', () => {
    render();
    expect(host.querySelector('[data-testid="workspace-defaults"]')?.textContent).toBe('Default: Mission branch · Auto-threshold');
    expect(rows().map((r) => r.querySelector('a')?.textContent)).toEqual(['example-api', 'example-app']);
  });

  it('a row on the defaults shows no settings chips; a differing value is a chip linking to its editor', () => {
    render();
    const [api, app] = rows();
    expect(app.querySelector('[data-testid^="workspace-differs-"]')).toBeNull();
    const chip = api.querySelector('[data-testid="workspace-differs-mergePolicy"]') as HTMLAnchorElement;
    expect(chip.textContent).toBe('Agent review');
    expect(chip.getAttribute('href')).toBe('/app/settings/workspace/ws-2');
  });

  it('the row name opens the workspace', () => {
    render();
    expect(rows()[1].querySelector('a')?.getAttribute('href')).toBe('/app/workspaces/ws-1');
  });

  it('shows where work runs, the last task and open tasks', () => {
    render();
    const app = rows()[1];
    expect(app.querySelector('[data-testid="workspace-runs-on"]')?.textContent).toBe('Runs on Cloud · large');
    expect(app.textContent).toContain('2d ago');
    expect(app.textContent).toContain('3 open');
  });

  it('health chips link to explain', () => {
    render();
    const api = rows()[0];
    expect(api.querySelector('[data-testid="workspace-health-red"]')?.textContent).toBe('1 red PR');
    expect(api.querySelector('[data-testid="workspace-health-stuck"]')?.getAttribute('href')).toBe('/app/tasks?workspace=ws-2');
    expect(rows()[1].querySelector('[data-testid^="workspace-health-"]')).toBeNull();
  });

  it('has no policy toggle in the list', () => {
    render();
    expect(host.querySelector('[role="switch"]')).toBeNull();
  });

  it('folds workspaces with no task in 30 days under Inactive (N)', async () => {
    render();
    const toggle = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Inactive (1)')) as HTMLButtonElement;
    expect(toggle).toBeDefined();
    expect(host.querySelector('[data-testid="workspace-inactive"]')).toBeNull();
    await act(async () => { toggle.click(); });
    const inactive = host.querySelector('[data-testid="workspace-inactive"]') as HTMLElement;
    expect(inactive.textContent).toContain('example-sandbox');
    // Not movable: its menu has Open but no Move to team….
    await act(async () => { (inactive.querySelector('[data-testid="workspace-row-menu"]') as HTMLButtonElement).click(); });
    expect([...inactive.querySelectorAll('a')].some((a) => a.textContent === 'Open')).toBe(true);
    expect([...inactive.querySelectorAll('button')].some((b) => b.textContent?.includes('Move to team'))).toBe(false);
  });

  it('team headings appear only when the rows span more than one team', () => {
    render();
    expect(host.querySelector('h3')).toBeNull();
    render([...ROWS, base({ id: 'ws-4', name: 'example-web', teamId: 'team-b', teamName: 'Team B' })]);
    expect([...host.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Team A', 'Team B']);
  });

  it('a team whose name cannot be resolved gets no heading, never "Unknown team"', () => {
    render([...ROWS, base({ id: 'ws-5', name: 'example-orphan', teamId: 'team-gone', teamName: null })]);
    expect([...host.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Team A']);
    expect(host.textContent).toContain('example-orphan');
    expect(host.textContent).not.toContain('Unknown team');
  });

  it('draws differs and health tags as tone pills, not outlined chips', () => {
    render();
    const api = rows()[0];
    expect(api.querySelector('[data-testid="workspace-differs-mergePolicy"] [data-tone="q"]')?.textContent).toBe('Agent review');
    expect(api.querySelector('[data-testid="workspace-health-red"] [data-tone="bad"]')).not.toBeNull();
  });

  it('the row menu offers Open always, and Move to team… only where a move is possible', async () => {
    render();
    const open = async (row: HTMLElement) => {
      const trigger = row.querySelector('[data-testid="workspace-row-menu"]') as HTMLButtonElement;
      await act(async () => { trigger.click(); });
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
    };
    const app = rows()[1];
    await open(app);
    expect([...app.querySelectorAll('a')].some((a) => a.textContent === 'Open')).toBe(true);
    const move = [...app.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Move to team…');
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
    const trigger = rows()[1].querySelector('[data-testid="workspace-row-menu"]') as HTMLButtonElement;
    await act(async () => { trigger.click(); });
    const open = [...rows()[1].querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Move to team…')!;
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

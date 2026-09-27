/**
 * MoveToTeamDialog, mounted in happy-dom. Pick a team and the dialog runs the
 * precheck (dry run) itself: no check button. A possible move shows one line
 * of consequences, when there are any, and enables Move. A blocked move says
 * why in one line and keeps Move disabled. Fixtures are illustrative.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspaces', width: 1280, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = mock(() => {});
mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/settings/workspaces',
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MoveToTeamDialog, consequenceLine } = await import('./MoveToTeamDialog');

const WORKSPACE = { id: 'ws-1', name: 'example-app', teamId: 'team-a' };
const TEAMS = [
  { id: 'team-a', name: 'Team A' },
  { id: 'team-b', name: 'Team B' },
  { id: 'team-c', name: 'Team C' },
];

type Groups = Array<Record<string, unknown>>;

const WITH_CONSEQUENCES: Groups = [
  { entity: 'Tasks', disposition: 'MOVES_CLEANLY', count: 12 },
  {
    entity: 'Secrets (workspace-scoped)', disposition: 'NEEDS_RE_ENTRY', count: 1,
    items: [{ key: 'secret:api_key:deploy', label: 'api_key "deploy"', disposition: 'NEEDS_RE_ENTRY' }],
  },
  {
    entity: 'Connectors', disposition: 'NEEDS_RE_AUTH', count: 2,
    items: [
      { key: 'connector:c1', label: '"Example Tracker" (oauth)', disposition: 'NEEDS_RE_AUTH' },
      { key: 'connector:c2', label: '"Example Chat" (oauth)', disposition: 'NEEDS_RE_AUTH' },
    ],
  },
  { entity: 'Missions (team-level)', disposition: 'LEFT_BEHIND', count: 2 },
];
const CLEAN: Groups = [{ entity: 'Tasks', disposition: 'MOVES_CLEANLY', count: 12 }];

function report(destinationTeamId: string, status: 'PASS' | 'FAIL', groups: Groups) {
  const requiredAcks = groups.flatMap((g) => ((g.items as Array<{ key: string }>) ?? []).map((i) => i.key));
  return {
    workspaceId: 'ws-1', workspaceName: 'example-app',
    sourceTeamId: 'team-a', sourceTeamName: 'Team A',
    destinationTeamId, destinationTeamName: TEAMS.find((t) => t.id === destinationTeamId)!.name,
    generatedAt: '2026-09-26T12:00:00Z',
    precheck: {
      status,
      githubApp: { org: null, ok: status === 'PASS', message: status === 'FAIL' ? 'Migration blocked: long server text.' : undefined },
    },
    groups,
    requiredAcks,
  };
}

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof mock>;
const realFetch = globalThis.fetch;
let precheckStatus: 'PASS' | 'FAIL' = 'PASS';
let groups: Groups = WITH_CONSEQUENCES;
const onClose = mock(() => {});
const onMoved = mock((_team: { id: string; name: string }) => {});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function defaultFetch(url: string, init?: RequestInit) {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.endsWith('/migrate/precheck')) {
    return json({ report: report(body.destinationTeamId, precheckStatus, groups), dryRunToken: `tok-${body.destinationTeamId}` });
  }
  if (url.endsWith('/migrate/execute')) {
    return json({ outcomes: [{ phase: 'reparent', status: 'ok' }] });
  }
  return json({}, 404);
}

beforeEach(() => {
  precheckStatus = 'PASS';
  groups = WITH_CONSEQUENCES;
  fetchMock = mock(async (url: string, init?: RequestInit) => defaultFetch(url, init));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  refresh.mockClear();
  onClose.mockClear();
  onMoved.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

async function render(teams = TEAMS) {
  await act(async () => {
    root.render(<MoveToTeamDialog workspace={WORKSPACE} teams={teams} onClose={onClose} onMoved={onMoved} />);
  });
}

function button(label: string): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  expect(b).toBeDefined();
  return b as HTMLButtonElement;
}

function picker(): HTMLButtonElement {
  const s = document.querySelector('[role="combobox"][aria-label="Destination team"]');
  expect(s).not.toBeNull();
  return s as HTMLButtonElement;
}

async function openOptions(): Promise<HTMLElement[]> {
  if (picker().getAttribute('aria-expanded') !== 'true') await act(async () => { picker().click(); });
  return [...document.querySelectorAll('[role="option"]')] as HTMLElement[];
}

async function pick(teamId: string) {
  const opt = (await openOptions()).find((o) => o.getAttribute('data-value') === teamId)!;
  await act(async () => { opt.click(); });
}

function calls(suffix: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
}

function dialogText() {
  return document.querySelector('[role="dialog"]')?.textContent ?? '';
}

describe('MoveToTeamDialog', () => {
  it('offers only the other teams as destinations', async () => {
    await render();
    const values = (await openOptions()).map((o) => o.getAttribute('data-value'));
    expect(values).toEqual(['team-b', 'team-c']);
  });

  it('has no check button, no checkboxes, and Move stays disabled until a team is picked', async () => {
    await render();
    expect([...document.querySelectorAll('button')].some((b) => /check/i.test(b.textContent ?? ''))).toBe(false);
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(calls('/migrate/precheck')).toHaveLength(0);
    expect(button('Move').disabled).toBe(true);
  });

  it('picking a team runs the check and shows one line of consequences', async () => {
    await render();
    await pick('team-b');

    expect(calls('/migrate/precheck')).toHaveLength(1);
    expect(JSON.parse(String((calls('/migrate/precheck')[0][1] as RequestInit).body))).toEqual({ destinationTeamId: 'team-b' });
    const line = document.querySelector('[data-testid="move-consequences"]');
    expect(line?.textContent).toBe('2 connectors need reconnecting · 1 workspace secret removed');
    // The dry-run inventory is not the user's step any more.
    expect(dialogText()).not.toContain('Tasks');
    expect(dialogText()).not.toContain('api_key "deploy"');
    expect(button('Move').disabled).toBe(false);
  });

  it('a move with no consequences shows no line at all', async () => {
    groups = CLEAN;
    await render();
    await pick('team-b');
    expect(document.querySelector('[data-testid="move-consequences"]')).toBeNull();
    expect(button('Move').disabled).toBe(false);
  });

  it('with one destination the check runs on open', async () => {
    await render(TEAMS.slice(0, 2));
    expect(calls('/migrate/precheck')).toHaveLength(1);
    expect(button('Move').disabled).toBe(false);
  });

  it('a blocked move says why in one line and disables Move', async () => {
    precheckStatus = 'FAIL';
    await render();
    await pick('team-b');
    const reason = document.querySelector('[data-testid="move-blocked"]');
    expect(reason?.textContent).toBe('Blocked: the GitHub App installation is missing or suspended.');
    expect(button('Move').disabled).toBe(true);
  });

  it('a refused check (not an admin on both teams) blocks with the server reason', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'You must be an admin on both teams to migrate a workspace.' }, 403));
    await render();
    await pick('team-b');
    expect(document.querySelector('[data-testid="move-blocked"]')?.textContent).toContain('admin on both teams');
    expect(button('Move').disabled).toBe(true);
  });

  it('a check answer for a team no longer picked is ignored', async () => {
    let releaseB: () => void = () => {};
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith('/migrate/precheck') && body.destinationTeamId === 'team-b') {
        await new Promise<void>((r) => { releaseB = r; });
        return json({ report: report('team-b', 'FAIL', CLEAN), dryRunToken: 'tok-team-b' });
      }
      return defaultFetch(url, init);
    });
    await render();
    await pick('team-b');
    await pick('team-c');
    await act(async () => { releaseB(); });
    expect(document.querySelector('[data-testid="move-blocked"]')).toBeNull();
    expect(button('Move').disabled).toBe(false);
  });

  it('Move executes with the checked team, token and every required item, then reports the team', async () => {
    await render();
    await pick('team-c');
    await act(async () => { button('Move').click(); });

    const exec = calls('/migrate/execute');
    expect(exec).toHaveLength(1);
    expect(String(exec[0][0])).toBe('/api/workspaces/ws-1/migrate/execute');
    expect(JSON.parse(String((exec[0][1] as RequestInit).body))).toEqual({
      destinationTeamId: 'team-c',
      dryRunToken: 'tok-team-c',
      confirmedItems: ['secret:api_key:deploy', 'connector:c1', 'connector:c2'],
    });
    expect(onMoved).toHaveBeenCalledWith({ id: 'team-c', name: 'Team C' });
    expect(refresh).toHaveBeenCalled();
  });

  it('an expired check re-runs by itself', async () => {
    await render();
    await pick('team-b');
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith('/migrate/execute') ? json({ error: 'invalid_token' }, 400) : defaultFetch(url, init));
    await act(async () => { button('Move').click(); });
    expect(calls('/migrate/precheck')).toHaveLength(2);
    expect(onMoved).not.toHaveBeenCalled();
    expect(button('Move').disabled).toBe(false);
  });
});

describe('consequenceLine', () => {
  const g = (entity: string, disposition: string, n: number) => ({
    entity, disposition, count: n,
    items: Array.from({ length: n }, (_, i) => ({ key: `${entity}:${i}`, label: String(i), disposition })),
  });

  it('counts each kind of loss once, singular or plural', () => {
    expect(consequenceLine([
      g('Connectors', 'NEEDS_RE_AUTH', 1),
      g('Secrets (workspace-scoped)', 'NEEDS_RE_ENTRY', 3),
      g('Account Access', 'WILL_BREAK', 2),
      g('Mission dependency chains', 'WILL_BREAK', 1),
      g('Role delegation chains', 'WILL_BREAK', 2),
    ] as never)).toBe(
      '1 connector needs reconnecting · 3 workspace secrets removed · 2 runner accounts lose access · 1 mission dependency breaks · 2 role delegations break',
    );
  });

  it('is empty when nothing is lost', () => {
    expect(consequenceLine([{ entity: 'Tasks', disposition: 'MOVES_CLEANLY', count: 4 }] as never)).toBe('');
  });
});

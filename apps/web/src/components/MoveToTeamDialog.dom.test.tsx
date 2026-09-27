/**
 * MoveToTeamDialog, mounted in happy-dom. One dialog, two steps: pick a team,
 * "Check what moves" runs the precheck (dry run) and shows the result inline,
 * and "Move workspace" is enabled only by a clean check for the team currently
 * picked. Fixtures are illustrative.
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
const { default: MoveToTeamDialog } = await import('./MoveToTeamDialog');

const WORKSPACE = { id: 'ws-1', name: 'example-app', teamId: 'team-a' };
const TEAMS = [
  { id: 'team-a', name: 'Team A' },
  { id: 'team-b', name: 'Team B' },
  { id: 'team-c', name: 'Team C' },
];

function report(destinationTeamId: string, status: 'PASS' | 'FAIL') {
  return {
    workspaceId: 'ws-1', workspaceName: 'example-app',
    sourceTeamId: 'team-a', sourceTeamName: 'Team A',
    destinationTeamId, destinationTeamName: TEAMS.find((t) => t.id === destinationTeamId)!.name,
    generatedAt: '2026-09-26T12:00:00Z',
    precheck: {
      status,
      githubApp: { org: null, ok: status === 'PASS', message: status === 'FAIL' ? 'GitHub App installation is suspended.' : undefined },
    },
    summary: { MOVES_CLEANLY: 2, NEEDS_RE_ENTRY: 1, NEEDS_RE_AUTH: 1, WILL_BREAK: 0, LEFT_BEHIND: 1 },
    groups: [
      { entity: 'Tasks', disposition: 'MOVES_CLEANLY', count: 12 },
      { entity: 'Artifacts', disposition: 'MOVES_CLEANLY', count: 0 },
      { entity: 'Workers', disposition: 'MOVES_CLEANLY', count: 3 },
      {
        entity: 'Secrets (workspace-scoped)', disposition: 'NEEDS_RE_ENTRY', count: 1,
        items: [{ key: 'secret:api_key:deploy', label: 'api_key "deploy"', disposition: 'NEEDS_RE_ENTRY' }],
      },
      {
        entity: 'Connectors', disposition: 'NEEDS_RE_AUTH', count: 1,
        items: [{ key: 'connector:c1', label: '"Example Tracker" (oauth)', disposition: 'NEEDS_RE_AUTH' }],
      },
      { entity: 'Missions (team-level)', disposition: 'LEFT_BEHIND', count: 2 },
    ],
    requiredAcks: ['secret:api_key:deploy', 'connector:c1'],
  };
}

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof mock>;
const realFetch = globalThis.fetch;
let precheckStatus: 'PASS' | 'FAIL' = 'PASS';
const onClose = mock(() => {});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  precheckStatus = 'PASS';
  fetchMock = mock(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith('/migrate/precheck')) {
      return json({ report: report(body.destinationTeamId, precheckStatus), dryRunToken: `tok-${body.destinationTeamId}` });
    }
    if (url.endsWith('/migrate/execute')) {
      return json({ outcomes: [{ phase: 'reparent', status: 'ok' }] });
    }
    return json({}, 404);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  refresh.mockClear();
  onClose.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

function render() {
  act(() => root.render(<MoveToTeamDialog workspace={WORKSPACE} teams={TEAMS} onClose={onClose} />));
}

function button(label: string): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  expect(b).toBeDefined();
  return b as HTMLButtonElement;
}

function select(): HTMLSelectElement {
  const s = document.querySelector('select');
  expect(s).not.toBeNull();
  return s as HTMLSelectElement;
}

async function click(b: HTMLButtonElement) {
  await act(async () => { b.click(); });
}

async function pick(teamId: string) {
  await act(async () => {
    const s = select();
    s.value = teamId;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function calls(suffix: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
}

describe('MoveToTeamDialog', () => {
  it('offers only the other teams as destinations', () => {
    render();
    const values = [...select().options].map((o) => o.value);
    expect(values).toEqual(['team-b', 'team-c']);
  });

  it('keeps Move workspace disabled until a check has run', () => {
    render();
    expect(button('Move workspace').disabled).toBe(true);
    expect(button('Check what moves').disabled).toBe(false);
  });

  it('a clean check enables Move and shows what moves, what is deleted and what to re-authorize', async () => {
    render();
    await click(button('Check what moves'));

    expect(calls('/migrate/precheck')).toHaveLength(1);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Tasks');
    expect(text).toContain('12');
    expect(text).toContain('api_key "deploy"');
    expect(text).toContain('"Example Tracker" (oauth)');
    // Empty groups are noise.
    expect(text).not.toContain('Artifacts');
    expect(button('Move workspace').disabled).toBe(false);
  });

  it('changing the destination after a clean check disables Move again', async () => {
    render();
    await click(button('Check what moves'));
    expect(button('Move workspace').disabled).toBe(false);

    await pick('team-c');
    expect(button('Move workspace').disabled).toBe(true);
    expect(document.body.textContent).not.toContain('api_key "deploy"');

    await click(button('Check what moves'));
    expect(button('Move workspace').disabled).toBe(false);
    const last = calls('/migrate/precheck').at(-1)!;
    expect(JSON.parse(String((last[1] as RequestInit).body))).toEqual({ destinationTeamId: 'team-c' });
  });

  it('a dirty check keeps Move disabled and says why', async () => {
    precheckStatus = 'FAIL';
    render();
    await click(button('Check what moves'));
    expect(document.body.textContent).toContain('GitHub App installation is suspended.');
    expect(button('Move workspace').disabled).toBe(true);
  });

  it('a failed check request keeps Move disabled', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'You must be an admin on both teams to migrate a workspace.' }, 403));
    render();
    await click(button('Check what moves'));
    expect(document.body.textContent).toContain('You must be an admin on both teams');
    expect(button('Move workspace').disabled).toBe(true);
  });

  it('Move workspace executes with the checked team, token and every required item', async () => {
    render();
    await pick('team-c');
    await click(button('Check what moves'));
    await click(button('Move workspace'));

    const exec = calls('/migrate/execute');
    expect(exec).toHaveLength(1);
    expect(String(exec[0][0])).toBe('/api/workspaces/ws-1/migrate/execute');
    expect(JSON.parse(String((exec[0][1] as RequestInit).body))).toEqual({
      destinationTeamId: 'team-c',
      dryRunToken: 'tok-team-c',
      confirmedItems: ['secret:api_key:deploy', 'connector:c1'],
    });
    expect(document.body.textContent).toContain('Moved to Team C');
    expect(refresh).toHaveBeenCalled();
  });

  it('an expired check disables Move and asks for a new check', async () => {
    render();
    await click(button('Check what moves'));
    fetchMock.mockImplementation(async () => json({ error: 'invalid_token' }, 400));
    await click(button('Move workspace'));
    expect(document.body.textContent).toContain('Check expired');
    expect(button('Move workspace').disabled).toBe(true);
  });
});

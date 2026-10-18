/**
 * Health › Runners, mounted (happy-dom). The owner asked to see the runner-slot
 * chart and the interactive sessions at first glance instead of behind a tap:
 * these pin that both render with no expand interaction, that a long sessions
 * list shows the first few with "Show all N" in place, and that the per-slot
 * timeline (the long diagnostic) stays folded until opened.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/health/runners' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  usePathname: () => '/app/health/runners',
  useSearchParams: () => new URLSearchParams(''),
}));
mock.module('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>{children as never}</a>
  ),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { HealthClient } = await import('./HealthClient');
const { buildFleetSnapshot } = await import('@/lib/fleet-view');
const { buildOccupancySeries } = await import('@/lib/fleet-occupancy');

const NOW = Date.now();
const H = 3_600_000;
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);
const RUNNER_URL = 'http://runner-one.local:8766';

/** One runner with a running task, and `sessions` claims from people's own sessions. */
function lanes(sessions: number, viewerId?: string) {
  const workers = [
    { id: 'w-run', ownerId: 'someone-else', accountId: 'acct', runner: RUNNER_URL, status: 'running', startedAt: ago(30), task: { id: 't-run', title: 'fix: keep captions readable', roleSlug: 'builder', missionId: null } },
    { id: 'w-done', accountId: 'acct', runner: RUNNER_URL, status: 'completed', startedAt: ago(90), completedAt: ago(60), task: { id: 't-done', title: 'feat: add a header', roleSlug: 'builder', missionId: null } },
    ...Array.from({ length: sessions }, (_, i) => ({
      id: `w-s${i}`, accountId: 'acct', runner: 'mcp', status: 'running', startedAt: ago(10 + i),
      task: { id: `t-s${i}`, title: `docs: session task number ${i + 1}`, roleSlug: null, missionId: null },
    })),
  ];
  return {
    fleet: buildFleetSnapshot([{ id: 'hb-1', accountId: 'acct', localUiUrl: RUNNER_URL, maxConcurrentWorkers: 3, lastHeartbeatAt: ago(0) }], workers, { now: NOW, viewerId }),
    idle: [],
    missions: {},
  };
}

const occupancy = buildOccupancySeries({
  window: '24h',
  now: NOW,
  workers: [
    { runner: RUNNER_URL, status: 'completed', startedAt: NOW - 5 * H, completedAt: NOW - 3 * H, updatedAt: null },
    { runner: 'mcp', status: 'completed', startedAt: NOW - 4 * H, completedAt: NOW - 2 * H, updatedAt: null },
  ],
});

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/proxy')) return new Response('{}', { status: 404 });
    const body = url.startsWith('/api/fleet/occupancy') ? occupancy : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const DEFAULT_RUNNERS = [{ id: 'hb-1', accountId: 'acct', accountName: 'Runner one', lastHeartbeatAt: ago(0).toISOString(), activeWorkerCount: 1, maxConcurrentWorkers: 3 }];

async function mount(sessions: number, runners: object[] = DEFAULT_RUNNERS, view: { viewerId?: string; seesTeamWork?: boolean } = {}) {
  await act(async () => {
    root.render(
      <HealthClient
        page="runners"
        orphanedPrs={[]}
        runners={runners as never}
        usageStats={null}
        consumption={null}
        schedules={[]}
        recentFailures={[]}
        credentialHealth={[]}
        strandedBackends={[]}
        wsFilter={null}
        budgetForecast={null}
        failureAnalytics={null}
        window="7d"
        subagentDelegation={null}
        errorPatterns={null}
        now={NOW}
        runnerLanes={lanes(sessions, view.viewerId) as never}
        seesTeamWork={view.seesTeamWork}
        {...({} as never)}
      />,
    );
  });
  // Let the occupancy fetch resolve and the chart render.
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const qa = (id: string) => [...container.querySelectorAll(`[data-testid="${id}"]`)];

describe('Health › Runners at first glance', () => {
  it('shows the runner-slot chart with its numbers, without any tap', async () => {
    await mount(1);
    const chart = q('health-section-occupancy');
    expect(chart).not.toBeNull();
    expect(chart!.textContent).toContain('Runner slots');
    expect(chart!.textContent).toContain('In use now');
    expect(chart!.querySelector('svg[aria-label^="Runner slots in use over the past 24 hours"]')).not.toBeNull();
  });

  it('shows interactive sessions, as a chart and as rows in words, without any tap', async () => {
    await mount(2);
    const sessionsChart = q('occupancy-sessions');
    expect(sessionsChart).not.toBeNull();
    expect(sessionsChart!.textContent).toContain('Interactive sessions');
    const groups = qa('running-now-group');
    const sessions = groups.find(g => g.textContent?.includes('Your sessions'));
    expect(sessions).toBeDefined();
    expect(sessions!.querySelectorAll('[data-testid="running-now-row"]').length).toBe(2);
    expect(sessions!.textContent).toContain('Working');
    expect(sessions!.textContent).toContain('session task number 1');
  });

  it('a long sessions list shows the first few and "Show all N" opens the rest in place', async () => {
    await mount(8);
    const sessions = () => qa('running-now-group').find(g => g.textContent?.includes('Your sessions'))!;
    expect(sessions().querySelectorAll('[data-testid="running-now-row"]').length).toBe(5);
    const more = sessions().querySelector('[data-testid="running-now-show-all"]') as HTMLButtonElement;
    expect(more.textContent).toBe('Show all 8');
    const href = location.href;
    await act(async () => { more.click(); });
    expect(sessions().querySelectorAll('[data-testid="running-now-row"]').length).toBe(8);
    expect(sessions().querySelector('[data-testid="running-now-show-all"]')).toBeNull();
    expect(location.href).toBe(href);
  });

  it('the runner list names and counts each runner the way Running now does', async () => {
    await mount(1);
    const group = qa('running-now-group').find(g => !g.textContent?.includes('Your sessions'))!;
    expect(group.textContent).toContain('runner-one');
    expect(group.textContent).toContain('1 of 3 busy');
    const row = q('health-runner-row')!;
    expect(row.querySelector('[data-testid="health-runner-name"]')!.textContent).toBe('runner-one');
    // The token's own name is secondary, so the row can still be found under Runner tokens.
    expect(row.textContent).toContain('Runner one');
    expect(row.textContent).toContain('1 of 3 busy');
    expect(row.textContent).not.toContain('agents running');
  });

  it('the per-slot timeline stays folded until opened', async () => {
    await mount(1);
    expect(q('runner-lanes-chart')).toBeNull();
    const toggle = [...q('health-section-lanes')!.querySelectorAll('button')].find(b => b.textContent?.includes('Timeline'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle.click(); });
    expect(q('runner-lanes-chart')).not.toBeNull();
  });
});

describe('Health › Runner row detail (R-5)', () => {
  it('is folded by default and expands on demand to slots, current work, connectivity and failures', async () => {
    await mount(0);
    const row = q('health-runner-row')!;
    expect(row.querySelector('[data-testid="health-runner-detail"]')).toBeNull();
    const btn = [...row.querySelectorAll('button')].find(b => b.textContent === 'Details') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const detail = row.querySelector('[data-testid="health-runner-detail"]')!;
    expect(detail).not.toBeNull();
    expect(detail.querySelectorAll('[data-testid="health-runner-slot"]').length).toBe(3);
    expect(detail.textContent).toContain('Working · ');
    expect(detail.textContent).toContain('Keep captions readable');
    expect(detail.querySelector('[data-testid="health-runner-connectivity"]')!.textContent).toContain('Connected');
    expect(detail.querySelector('[data-testid="health-runner-failures"]')).not.toBeNull();
  });
});

describe('Health › Runner row detail (R-7)', () => {
  const open = async (view: Parameters<typeof mount>[2]) => {
    await mount(0, DEFAULT_RUNNERS, view);
    const row = q('health-runner-row')!;
    const btn = [...row.querySelectorAll('button')].find(b => b.textContent === 'Details') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return row.querySelector('[data-testid="health-runner-detail"]')!;
  };

  it("names a teammate's run only to someone who may read the team's work", async () => {
    const detail = await open({ viewerId: 'me', seesTeamWork: false });
    expect(detail.textContent).toContain("A teammate's work");
    expect(detail.textContent).not.toContain('Keep captions readable');
    expect(detail.querySelectorAll('[data-testid="health-runner-slot"]').length).toBe(3);
  });

  it('names it for a team viewer, and a member keeps their own', async () => {
    expect((await open({ viewerId: 'me', seesTeamWork: true })).textContent).toContain('Keep captions readable');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    expect((await open({ viewerId: 'someone-else', seesTeamWork: false })).textContent).toContain('Keep captions readable');
  });
});

describe('Health › Runners ownership', () => {
  const hb = (id: string, name: string, mine: boolean) => ({ id, accountId: id, accountName: name, lastHeartbeatAt: ago(0).toISOString(), activeWorkerCount: 0, maxConcurrentWorkers: 2, mine });

  it('lists the viewer\'s runners under "Your runners" and teammates\' under "Team runners"', async () => {
    await mount(0, [hb('a', 'Mine one', true), hb('b', 'Teammate box', false)]);
    const mine = q('health-runners-mine');
    const team = q('health-runners-team');
    expect(mine!.textContent).toContain('Your runners');
    expect(mine!.textContent).toContain('Mine one');
    expect(mine!.textContent).not.toContain('Teammate box');
    expect(team!.textContent).toContain('Team runners');
    expect(team!.textContent).toContain('Teammate box');
  });

  it('labels managed, team-host and personal runners by their recorded class', async () => {
    await mount(0, [
      { ...hb('a', 'Mine one', true), runnerClass: 'personal' },
      { ...hb('b', 'Cloud', false), runnerClass: 'managed' },
      { ...hb('c', 'Host', false), runnerClass: 'team' },
    ]);
    expect(q('health-runners-mine')!.textContent).toContain('personal');
    const team = q('health-runners-team')!.textContent!;
    expect(team).toContain('managed');
    expect(team).toContain('team host');
  });

  it('omits a section with no runners', async () => {
    await mount(0, [hb('a', 'Mine one', true)]);
    expect(q('health-runners-mine')).not.toBeNull();
    expect(q('health-runners-team')).toBeNull();
  });
});

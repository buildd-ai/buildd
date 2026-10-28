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
  it('leads with the shared Capacity block: running, runners and sessions, peak and average, the picker, one chart', async () => {
    await mount(2);
    const cap = q('capacity')!;
    expect(cap).not.toBeNull();
    expect(cap.textContent).toContain('1 of 3 slots in use');
    expect(cap.textContent).toContain('1 of 1 runner online · plus 2 Claude Code sessions');
    expect(q('capacity-peak')!.textContent).toContain('over 24h');
    expect(q('capacity-peak')!.textContent).toContain('Peak 1');
    expect(q('capacity-chart')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="capacity-chart"]').length).toBe(1);
    // Capacity comes before the runner sections.
    const order = [...container.querySelectorAll('[data-testid="capacity"], [data-testid="health-section-runners"]')].map(e => e.getAttribute('data-testid'));
    expect(order).toEqual(['capacity', 'health-section-runners']);
    // Nothing is idle while work waits, so no alert.
    expect(q('idle-alert')).toBeNull();
  });

  it('keeps the per-owner usage chart one tap away, with sessions charted separately', async () => {
    await mount(1);
    expect(q('health-section-occupancy')).toBeNull();
    const toggle = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Usage by owner'))!;
    await act(async () => { toggle.click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(q('health-section-occupancy')!.textContent).toContain('In use now');
    expect(q('occupancy-sessions')!.textContent).toContain('Interactive sessions');
  });

  it('lists interactive sessions as rows in words without any tap, and not the runners (the rows below say those)', async () => {
    await mount(2);
    const groups = qa('running-now-group');
    expect(groups.length).toBe(1);
    expect(groups[0].textContent).toContain('Your sessions');
    expect(groups[0].querySelectorAll('[data-testid="running-now-row"]').length).toBe(2);
    expect(groups[0].textContent).toContain('Working');
    expect(groups[0].textContent).toContain('session task number 1');
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

  it('the runner row names and counts the runner from the fleet', async () => {
    await mount(1);
    const row = q('health-runner-row')!;
    expect(row.querySelector('[data-testid="health-runner-name"]')!.textContent).toBe('runner-one');
    // The token's own name is secondary, so the row can still be found under Runner tokens.
    expect(row.textContent).toContain('Runner one');
    expect(row.textContent).toContain('1 of 3 slots in use');
    expect(row.textContent).not.toContain('agents running');
  });

  it('the per-slot timeline stays folded until opened', async () => {
    await mount(1);
    expect(q('runner-lanes-chart')).toBeNull();
    const toggle = [...q('health-section-lanes')!.querySelectorAll('button')].find(b => b.textContent?.includes('Timeline by slot'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle.click(); });
    expect(q('runner-lanes-chart')).not.toBeNull();
  });
});

describe('Health › Runners idle alert (R-16)', () => {
  it('shows the shared IdleAlert under Capacity only while an idle stretch with waiting work is open', async () => {
    const withIdle = (to: number) => ({ ...lanes(0), idle: [{ from: NOW - 3_600_000, to, waited: 3 }] });
    const render = async (l: unknown) => {
      await act(async () => {
        root.render(
          <HealthClient page="runners" orphanedPrs={[]} runners={DEFAULT_RUNNERS as never} usageStats={null} consumption={null} schedules={[]} recentFailures={[]} credentialHealth={[]} strandedBackends={[]} wsFilter={null} budgetForecast={null} failureAnalytics={null} window="7d" subagentDelegation={null} errorPatterns={null} now={NOW} runnerLanes={l as never} {...({} as never)} />,
        );
      });
      for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    };
    await render(withIdle(NOW));
    expect(q('idle-alert')!.textContent).toContain('3 tasks could start');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render(withIdle(NOW - 2 * H));
    expect(q('idle-alert')).toBeNull();
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

  it('keeps runner owner type, work principal and effective route as three separate lines (R-9)', async () => {
    await mount(0, [{ ...DEFAULT_RUNNERS[0], runnerClass: 'managed', modelAuthSource: 'machine_login', codexAuthSource: null } as any]);
    const row = q('health-runner-row')!;
    const btn = [...row.querySelectorAll('button')].find(b => b.textContent === 'Details') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const detail = row.querySelector('[data-testid="health-runner-detail"]')!;
    expect(detail.querySelector('[data-testid="health-runner-owner"]')!.textContent).toBe('managed');
    expect(detail.querySelector('[data-testid="health-runner-route"]')!.textContent).toBe('Claude: local plan login · Codex: not reported');
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
  const hb = (id: string, name: string, mine: boolean) => ({ id, accountId: id, accountName: name, lastHeartbeatAt: ago(0).toISOString(), activeWorkerCount: 0, maxConcurrentWorkers: 2, mine, runnerClass: 'personal' as const });

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

  it('keeps a managed or team-host runner the viewer created out of "Your runners"', async () => {
    await mount(0, [
      { ...hb('a', 'Mine one', true), runnerClass: 'personal' },
      { ...hb('b', 'Cloud', true), runnerClass: 'managed' },
      { ...hb('c', 'Host', true), runnerClass: 'team' },
    ]);
    const mine = q('health-runners-mine')!.textContent!;
    expect(mine).toContain('Mine one');
    expect(mine).not.toContain('Cloud');
    expect(mine).not.toContain('Host');
    const team = q('health-runners-team')!.textContent!;
    expect(team).toContain('Cloud');
    expect(team).toContain('Host');
  });

  it('omits a section with no runners', async () => {
    await mount(0, [hb('a', 'Mine one', true)]);
    expect(q('health-runners-mine')).not.toBeNull();
    expect(q('health-runners-team')).toBeNull();
  });
});


describe('Health › Lifetime history privacy (AC-4)', () => {
  for (const mine of [false, true]) {
    it(`${mine ? 'owner retains' : 'linked-team viewer cannot request'} lifetime totals when expanding a runner`, async () => {
      const requested: string[] = [];
      const fallback = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes('/proxy')) return fallback(input, init);
        requested.push(url);
        const data = url.includes('history')
          ? { totalSessions: 73, totalCost: 12, avgDurationMs: 60000, byStatus: {} }
          : { timestamp: new Date(NOW).toISOString(), checks: [], summary: { ok: 1, warn: 0, error: 0 } };
        return new Response(JSON.stringify(data), { status: 200 });
      }) as typeof fetch;
      await mount(0, [{ ...DEFAULT_RUNNERS[0], mine, runnerClass: 'personal' }]);
      const row = q('health-runner-row')!;
      const button = [...row.querySelectorAll('button')].find(b => b.textContent === 'Details')!;
      await act(async () => { button.click(); });
      for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      expect(requested.some(url => url.includes('history'))).toBe(mine);
      expect(row.textContent!.includes('Session history')).toBe(mine);
      if (mine) {
        expect(row.textContent).toContain('73');
        expect(row.textContent).toContain('Total cost');
        expect(row.textContent).toContain('Avg duration');
      }
    });
  }
});

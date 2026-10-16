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
function lanes(sessions: number) {
  const workers = [
    { id: 'w-run', accountId: 'acct', runner: RUNNER_URL, status: 'running', startedAt: ago(30), task: { id: 't-run', title: 'fix: keep captions readable', roleSlug: 'builder', missionId: null } },
    { id: 'w-done', accountId: 'acct', runner: RUNNER_URL, status: 'completed', startedAt: ago(90), completedAt: ago(60), task: { id: 't-done', title: 'feat: add a header', roleSlug: 'builder', missionId: null } },
    ...Array.from({ length: sessions }, (_, i) => ({
      id: `w-s${i}`, accountId: 'acct', runner: 'mcp', status: 'running', startedAt: ago(10 + i),
      task: { id: `t-s${i}`, title: `docs: session task number ${i + 1}`, roleSlug: null, missionId: null },
    })),
  ];
  return {
    fleet: buildFleetSnapshot([{ id: 'hb-1', accountId: 'acct', localUiUrl: RUNNER_URL, maxConcurrentWorkers: 3, lastHeartbeatAt: ago(0) }], workers, { now: NOW }),
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

async function mount(sessions: number) {
  await act(async () => {
    root.render(
      <HealthClient
        page="runners"
        orphanedPrs={[]}
        runners={[{ id: 'hb-1', accountId: 'acct', accountName: 'Runner one', lastHeartbeatAt: ago(0).toISOString(), activeWorkerCount: 1, maxConcurrentWorkers: 3 } as never]}
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
        runnerLanes={lanes(sessions) as never}
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

  it('the per-slot timeline stays folded until opened', async () => {
    await mount(1);
    expect(q('runner-lanes-chart')).toBeNull();
    const toggle = [...q('health-section-lanes')!.querySelectorAll('button')].find(b => b.textContent?.includes('Timeline'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle.click(); });
    expect(q('runner-lanes-chart')).not.toBeNull();
  });
});

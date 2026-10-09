import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks' });
import { expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { buildActivityNow, WAITING_ROWS_PER_GROUP } from '@/lib/activity-delivery';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ActivityView } = await import('./ActivityView');

it('expands standalone waiting tasks in place and collapses them again', () => {
  const nowMs = Date.parse('2026-10-08T12:00:00Z');
  const tasks = Array.from({ length: 5 }, (_, i) => ({
    id: `waiting-${i}`, title: `Waiting task ${i}`, status: 'pending',
    missionId: null, createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString(), workers: [],
  }));
  const now = buildActivityNow({ tasks, missions: [], rules, now: nowMs });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ActivityView mode="now" now={now} history={[]} latest={null} nowMs={nowMs} hrefs={{ now: '/app/tasks', history: '/app/tasks?view=history' }} />));
    const group = container.querySelector('[data-mission="standalone"]')!;
    const rowLinks = () => [...group.querySelectorAll('[data-testid="activity-now-row"] a')].map(a => a.getAttribute('href'));
    expect(rowLinks()).toEqual(tasks.slice(0, WAITING_ROWS_PER_GROUP).map(t => `/app/tasks/${t.id}`));
    const toggle = [...group.querySelectorAll('button')].find(b => b.textContent?.includes('more waiting'))!;
    expect(toggle).toBeDefined();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(rowLinks()).toEqual(tasks.map(t => `/app/tasks/${t.id}`));
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(rowLinks()).toHaveLength(WAITING_ROWS_PER_GROUP);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('History pages: the first 20 deliveries, then "Show N more"; a filter starts the paging over', () => {
  const nowMs = Date.parse('2026-10-08T12:00:00Z');
  const history = Array.from({ length: 25 }, (_, i) => ({
    id: `ep-${i}`, title: `Delivery ${i}`, href: `/app/tasks/ep-${i}`, missionId: null, missionTitle: null,
    kind: (i === 3 ? 'needs' : 'landed') as 'needs' | 'landed', repairRounds: 0, at: nowMs - i * 3_600_000, steps: [],
  }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ActivityView mode="history" now={{ groups: [], inMotion: 0, liveAgents: 0 }} history={history} nowMs={nowMs} hrefs={{ now: '/app/tasks', history: '/app/tasks?view=history' }} />));
    const episodes = () => container.querySelectorAll('[data-testid="activity-episode"]').length;
    const more = () => container.querySelector<HTMLButtonElement>('[data-testid="activity-history-more"]');
    expect(episodes()).toBe(20);
    expect(more()?.textContent).toBe('Show 5 more');
    act(() => more()!.click());
    expect(episodes()).toBe(25);
    expect(more()).toBeNull();
    const chip = [...container.querySelectorAll('button')].find(b => b.textContent === 'Sent to you')!;
    act(() => chip.click());
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(episodes()).toBe(1);
    expect(container.querySelectorAll('[data-testid="activity-day"]').length).toBe(1);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('a mission group whose projection did not load counts its tasks instead of "0/0 landed"', () => {
  const nowMs = Date.parse('2026-10-08T12:00:00Z');
  const now = buildActivityNow({
    tasks: [{ id: 'm-t1', title: 'Mission task', status: 'in_progress', missionId: 'gone', createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString(), workers: [{ status: 'running' }] }],
    missions: [], rules, now: nowMs,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ActivityView mode="now" now={now} history={[]} nowMs={nowMs} hrefs={{ now: '/app/tasks', history: '/app/tasks?view=history' }} />));
    expect(container.textContent).not.toContain('0/0 landed');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});


it('failed loads remain failures in both tabs, without empty copy or counts', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    for (const mode of ['now', 'history'] as const) {
      act(() => root.render(<ActivityView mode={mode} now={{ groups: [], inMotion: 0, liveAgents: 0 }} history={[]} nowMs={0} hrefs={{ now: '/app/tasks', history: '/app/tasks?view=history' }} loadError />));
      expect(container.querySelector('[data-testid="activity-load-error"]')?.getAttribute('role')).toBe('alert');
      expect(container.querySelector('[data-testid="activity-counts"]')).toBeNull();
      expect(container.querySelector('[data-testid="activity-empty"]')).toBeNull();
    }
  } finally { act(() => root.unmount()); }
});

it('a History filter that hides finished deliveries offers to clear it', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const history = [{ id: 'landed', title: 'Finished delivery', href: '/app/tasks/landed', missionId: null, missionTitle: null, kind: 'landed' as const, repairRounds: 0, at: 0, steps: [] }];
  try {
    act(() => root.render(<ActivityView mode="history" now={{ groups: [], inMotion: 0, liveAgents: 0 }} history={history} nowMs={0} hrefs={{ now: '/app/tasks', history: '/app/tasks?view=history' }} initialFilters={{ outcome: 'retries' }} />));
    expect(container.querySelector('[data-testid="activity-filtered-empty"]')?.textContent).toContain('1 episode in History');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="activity-clear-filters"]')!.click());
    expect(container.querySelectorAll('[data-testid="activity-episode"]')).toHaveLength(1);
  } finally { act(() => root.unmount()); }
});

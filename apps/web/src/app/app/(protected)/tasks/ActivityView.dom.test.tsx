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

it('History pages: the first 20 deliveries, then "Show more"; a filter starts the paging over', () => {
  const nowMs = Date.parse('2026-10-08T12:00:00Z');
  const history = Array.from({ length: 25 }, (_, i) => ({
    id: `ep-${i}`, title: `Delivery ${i}`, href: `/app/tasks/ep-${i}`, missionId: null, missionTitle: null,
    kind: (i === 3 ? 'needs' : 'landed') as 'needs' | 'landed', repairRounds: 0, at: nowMs - i * 86_400_000, steps: [],
  }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ActivityView mode="history" now={{ groups: [], inMotion: 0, liveAgents: 0 }} history={history} nowMs={nowMs} hrefs={{ now: '/app/tasks', history: '/app/tasks?view=history' }} />));
    const episodes = () => container.querySelectorAll('[data-testid="activity-episode"]').length;
    const more = () => container.querySelector<HTMLButtonElement>('[data-testid="activity-history-more"]');
    expect(episodes()).toBe(20);
    expect(more()?.textContent).toBe('Show more');
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
    expect(container.textContent).not.toContain('0/0 merged');
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


it('History-only outcomes do not hide live rows when switching to Now', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const nowMs = Date.parse('2026-10-08T12:00:00Z');
  const now = buildActivityNow({ tasks: [{ id: 'live', title: 'Live work', status: 'in_progress', missionId: null, createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString(), workers: [{ status: 'running' }] }], missions: [], rules, now: nowMs });
  const props = { now, history: [], nowMs, hrefs: { now: '/app/tasks', history: '/app/tasks?view=history' } };
  try {
    act(() => root.render(<ActivityView mode="history" {...props} />));
    const landed = [...container.querySelectorAll('button')].find(b => b.textContent === 'Merged')!;
    act(() => landed.click());
    act(() => root.render(<ActivityView mode="now" {...props} />));
    expect(container.querySelectorAll('[data-testid="activity-now-row"]')).toHaveLength(1);
    act(() => root.render(<ActivityView mode="history" {...props} />));
    expect([...container.querySelectorAll('button')].find(b => b.textContent === 'Merged')?.getAttribute('aria-pressed')).toBe('true');
  } finally { act(() => root.unmount()); }
});

it('AC-1: a new mission that started at once shows once, marked New, created apart from its last activity', async () => {
  const { activityContextFixture, ACTIVITY_FIXTURE_NOW, NEW_MISSION } = await import('@/app/app/dev/fixtures/activity-delivery-fixtures');
  const f = activityContextFixture();
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<ActivityView mode="now" now={f.now} history={f.history} nowMs={ACTIVITY_FIXTURE_NOW} hrefs={{ now: '/app/tasks', history: '/app/tasks?view=history' }} />));
    const groups = container.querySelectorAll(`[data-mission="${NEW_MISSION.id}"]`);
    expect(groups).toHaveLength(1);
    // One New marker for the mission; its tasks do not repeat it.
    expect(groups[0].querySelectorAll('[data-testid="activity-new"]')).toHaveLength(1);
    expect(groups[0].querySelectorAll('[data-testid="activity-now-row"] [data-testid="activity-new"]')).toHaveLength(0);
    // A new standalone task carries its own marker, on its row.
    expect(container.querySelector('[data-row="fx-solo"] [data-testid="activity-new"]')).not.toBeNull();
    expect(groups[0].querySelector('[data-testid="activity-created"]')?.textContent).toBe('created 8m ago');
    const current = groups[0].querySelector('[data-testid="activity-current"]')!;
    expect(current.querySelector('a')?.getAttribute('href')).toBe('/app/tasks/fx-new-1');
    const row = [...groups[0].querySelectorAll('[data-testid="activity-now-row"]')].find(r => r.querySelector('[data-testid="activity-transition"]')?.textContent?.includes('Build started'))!;
    expect(row.querySelector('[data-testid="activity-transition"]')?.textContent).toBe('Build started · 6m ago');
    expect(row.querySelector('[data-testid="activity-created"]')?.textContent).toBe('created 7m ago');
    act(() => root.render(<ActivityView mode="history" now={f.now} history={f.history} nowMs={ACTIVITY_FIXTURE_NOW} hrefs={{ now: '/app/tasks', history: '/app/tasks?view=history' }} />));
    // A creation is no delivery: History draws a bar per delivery and no event line.
    expect(container.querySelector('[data-testid="activity-created-event"]')).toBeNull();
  } finally { act(() => root.unmount()); }
});

it('AC-2: a five-generation chain is one row whose attempts expand, each linking to its task and its real parent', async () => {
  const { activityContextFixture, ACTIVITY_FIXTURE_NOW, CHAIN_ROOT } = await import('@/app/app/dev/fixtures/activity-delivery-fixtures');
  const f = activityContextFixture();
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<ActivityView mode="now" now={f.now} history={[]} nowMs={ACTIVITY_FIXTURE_NOW} hrefs={{ now: '/app/tasks', history: '/app/tasks?view=history' }} />));
    const rows = [...container.querySelectorAll('[data-testid="activity-now-row"]')].filter(r => r.getAttribute('data-row') === CHAIN_ROOT);
    expect(rows).toHaveLength(1);
    const derived = rows[0].querySelector('[data-testid="activity-derived"]')!;
    const toggle = derived.querySelector('button')!;
    expect(toggle.textContent).toContain('2 reviews · repair tasks');
    expect(toggle.textContent).not.toContain('derived');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(derived.querySelectorAll('[data-testid="activity-derived-child"]')).toHaveLength(0);
    act(() => toggle.click());
    const kids = [...derived.querySelectorAll('[data-testid="activity-derived-child"]')];
    expect(kids[0].textContent).toMatch(/· generation 1/);
    expect(kids.some(k => /· gen \d/.test(k.textContent ?? ''))).toBe(false);
    expect(kids.map(k => k.querySelector('[data-testid="activity-derived-task"]')?.getAttribute('href')))
      .toEqual(['g1', 'g2', 'g3', 'g4', 'g5'].map(g => `/app/tasks/fx-chain-${g}`));
    expect(kids.map(k => k.querySelector('[data-testid="activity-derived-parent"]')?.getAttribute('href')))
      .toEqual([CHAIN_ROOT, 'fx-chain-g1', 'fx-chain-g2', 'fx-chain-g3', 'fx-chain-g4'].map(id => `/app/tasks/${id}`));
    expect(kids.every(k => k.querySelector('[data-testid="activity-derived-mission"]')?.getAttribute('href') === '/app/missions/fx-flaky')).toBe(true);
  } finally { act(() => root.unmount()); }
});

it('a delivery with one failed repair says so once: the repair line, not the meta line or the attempts summary', async () => {
  const { ACTIVITY_FIXTURE_NOW, CHAIN_ROOT, fiveGenerationChain } = await import('@/app/app/dev/fixtures/activity-delivery-fixtures');
  const [rootTask, , , , ciRepair] = fiveGenerationChain(null);
  const failed = { ...ciRepair, parentTaskId: CHAIN_ROOT, status: 'failed', updatedAt: '2026-10-08T10:50:00.000Z',
    workers: [{ status: 'failed', startedAt: '2026-10-08T10:30:00.000Z', completedAt: '2026-10-08T10:50:00.000Z', updatedAt: '2026-10-08T10:50:00.000Z' }] };
  const now = buildActivityNow({ tasks: [rootTask, failed], missions: [], rules, now: ACTIVITY_FIXTURE_NOW });
  const row = now.groups.flatMap(g => g.rows).find(r => r.id === CHAIN_ROOT)!;
  // The projection still tells it: History and the mission header read the same step.
  expect(row.transition).toMatchObject({ text: 'Repair 1 failed', repair: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<ActivityView mode="now" now={now} history={[]} nowMs={ACTIVITY_FIXTURE_NOW} hrefs={{ now: '/app/tasks', history: '/app/tasks?view=history' }} />));
    const el = container.querySelector(`[data-row="${CHAIN_ROOT}"]`)!;
    const repairs = [...el.querySelectorAll('[data-testid="activity-repair"]')];
    expect(repairs).toHaveLength(1);
    expect(repairs[0].getAttribute('data-status')).toBe('failed');
    expect(el.querySelector('[data-testid="activity-transition"]')).toBeNull();
    const summary = el.querySelector('[data-testid="activity-derived"] button')!.textContent ?? '';
    expect(summary).not.toMatch(/1 repair|1 attempt/);
    expect(summary).toContain('Repair tasks');
    expect(el.textContent).not.toContain('Repair 1 failed');
    // Its link to the repair task is still one click away.
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="activity-derived"] button')!.click());
    expect(el.querySelectorAll('[data-testid="activity-derived-child"]')).toHaveLength(1);
  } finally { act(() => root.unmount()); }
});

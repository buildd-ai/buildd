import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks' });
import { expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { buildActivityNow, type ActivityTaskInput } from '@/lib/activity-delivery';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ActivityView } = await import('./ActivityView');

const hrefs = { now: '/app/tasks', history: '/app/tasks?view=history' };

it('queued work is the last group, folded, and opens in place with every queued delivery', () => {
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
    act(() => root.render(<ActivityView mode="now" now={now} history={[]} nowMs={nowMs} hrefs={hrefs} />));
    // The Pipeline counts every queued delivery, folded behind "+N more" in the projection or not.
    expect(container.querySelector('[data-testid="pipeline"] [data-stage="queued"] [data-count]')?.getAttribute('data-count')).toBe('5');
    const group = container.querySelector('[data-testid="activity-stage"][data-stage="queued"]')!;
    const rowLinks = () => [...group.querySelectorAll('[data-testid="activity-now-row"] a')].map(a => a.getAttribute('href'));
    const toggle = group.querySelector('button')!;
    expect(toggle.textContent).toContain('5 queued');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(rowLinks()).toHaveLength(0);
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(rowLinks()).toEqual(tasks.map(t => `/app/tasks/${t.id}`));
    act(() => toggle.click());
    expect(rowLinks()).toHaveLength(0);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('AC-11: with nothing waiting the phone opens on a green dot and "Nothing waiting on you"; else on the decision, whose row reads waiting on you', () => {
  const nowMs = Date.parse('2026-10-08T12:00:00Z');
  const iso = new Date(nowMs).toISOString();
  const building: ActivityTaskInput = { id: 'b', title: 'Building work', status: 'in_progress', missionId: null, createdAt: iso, updatedAt: iso, workers: [{ status: 'running' }] };
  const asking: ActivityTaskInput = { id: 'q', title: 'Pick the rail order', status: 'in_progress', missionId: null, createdAt: iso, updatedAt: iso, workers: [{ status: 'waiting_input' }], waitingPrompt: 'Which first?' };
  const container = document.createElement('div');
  const root = createRoot(container);
  const first = () => container.querySelector('[data-testid="activity-now-phone"]')!.firstElementChild!;
  try {
    act(() => root.render(<ActivityView mode="now" now={buildActivityNow({ tasks: [building], missions: [], rules, now: nowMs })} history={[]} nowMs={nowMs} hrefs={hrefs} />));
    expect(first().getAttribute('data-testid')).toBe('you-strip');
    expect(first().getAttribute('data-waiting')).toBe('0');
    expect(first().querySelector('[data-testid="you-strip-dot"]')).not.toBeNull();
    expect(first().textContent).toBe('Nothing waiting on you in this team');

    act(() => root.render(<ActivityView mode="now" now={buildActivityNow({ tasks: [building, asking], missions: [], rules, now: nowMs })} history={[]} nowMs={nowMs} hrefs={hrefs} />));
    expect(first().getAttribute('data-waiting')).toBe('1');
    const card = first().querySelector('[data-testid="you-strip-card"]')!;
    expect(card.getAttribute('data-item')).toBe('q');
    expect(card.querySelector('a')?.getAttribute('href')).toBe('/app/tasks/q');
    const meter = container.querySelector('[data-testid="activity-now-row"][data-row="q"] [data-testid="delivery-meter"]')!;
    expect(meter.getAttribute('data-state')).toBe('waiting-on-you');
    expect(first().querySelector('[data-testid="you-strip-scope"]')?.textContent).toContain('this team');
    // The desktop rail carries the same strip under Waiting on you.
    expect(container.querySelector('[data-testid="activity-rail-waiting"] [data-testid="you-strip-card"]')?.getAttribute('data-item')).toBe('q');
  } finally { act(() => root.unmount()); }
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

it('AC-18: a new mission that started at once shows once, with no New pill and no created time on its rows', async () => {
  const { activityContextFixture, ACTIVITY_FIXTURE_NOW, NEW_MISSION } = await import('@/app/app/dev/fixtures/activity-delivery-fixtures');
  const f = activityContextFixture();
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<ActivityView mode="now" now={f.now} history={f.history} nowMs={ACTIVITY_FIXTURE_NOW} hrefs={hrefs} />));
    const rows = [...container.querySelectorAll('[data-testid="activity-now-row"]')].map(r => r.getAttribute('data-row'));
    expect(rows.filter(id => id === 'fx-new-1')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="activity-now-card"][data-row="fx-new-1"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="activity-new"]')).toBeNull();
    expect(container.textContent).not.toContain('New');
    expect(container.textContent).not.toMatch(/created \d/);
    // Its tag is the mission, and its row links to the task page that carries its creation.
    const row = container.querySelector('[data-testid="activity-now-row"][data-row="fx-new-1"]')!;
    expect(row.querySelector('[data-testid="delivery-tag"]')?.textContent).toBe(NEW_MISSION.title);
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/app/tasks/fx-new-1');
    // The mission is in the rail once.
    expect([...container.querySelectorAll('[data-testid="activity-rail-mission"]')].filter(m => m.textContent?.includes(NEW_MISSION.title))).toHaveLength(1);
  } finally { act(() => root.unmount()); }
});

it('AC-19: a five-generation review/repair chain is one row, its fix rounds on the meter, and no attempt gets a row', async () => {
  const { activityContextFixture, ACTIVITY_FIXTURE_NOW, CHAIN_ROOT } = await import('@/app/app/dev/fixtures/activity-delivery-fixtures');
  const f = activityContextFixture();
  const chain = f.now.groups.flatMap(g => g.rows).find(r => r.id === CHAIN_ROOT)!;
  expect(chain.children).toHaveLength(5);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<ActivityView mode="now" now={f.now} history={[]} nowMs={ACTIVITY_FIXTURE_NOW} hrefs={hrefs} />));
    const ids = [...container.querySelectorAll('[data-testid="activity-now-row"]')].map(r => r.getAttribute('data-row'));
    expect(ids.filter(id => id === CHAIN_ROOT)).toHaveLength(1);
    expect(ids.some(id => id?.startsWith('fx-chain-g'))).toBe(false);
    const meter = container.querySelector(`[data-testid="activity-now-row"][data-row="${CHAIN_ROOT}"] [data-testid="delivery-meter"]`)!;
    expect(meter.getAttribute('data-state')).toBe('fixing-in-verify');
    expect(meter.querySelector('[data-mark]')?.getAttribute('data-mark')).toBe(`↻${chain.delivery.repairRounds}`);
    expect(chain.delivery.repairRounds).toBeGreaterThan(0);
    // While it is being fixed the tag names the check beside the mission.
    expect(container.querySelector(`[data-row="${CHAIN_ROOT}"] [data-testid="delivery-tag"]`)?.textContent).toMatch(/^Quarantine flaky integration tests · /);
  } finally { act(() => root.unmount()); }
});

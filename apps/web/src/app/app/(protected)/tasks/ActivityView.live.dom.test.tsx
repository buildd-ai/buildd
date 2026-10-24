import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks' });
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { buildActivityNow, type ActivityNow, type ActivityTaskInput, type NowGroup } from '@/lib/activity-delivery';
import { ACTIVITY_FIXTURE_NOW, activityContextFixture, activityFixture, activityStatesFixture } from '../../dev/fixtures/activity-delivery-fixtures';
import { anchorShift } from './stable-live';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ActivityView } = await import('./ActivityView');

/**
 * Spec 9430a28f R-7: a live update (a Pusher event's re-read, a catch-up
 * refresh) renders the view again with new rows. What is open, what has focus
 * and where the reader is stay put, and no delivery shows twice.
 */
const hrefs = { now: '/app/tasks', history: '/app/tasks?view=history' };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = (now: ActivityNow, mode: 'now' | 'history' = 'now', history = activityFixture(4).history) =>
  act(() => root.render(<ActivityView mode={mode} now={now} history={history} nowMs={ACTIVITY_FIXTURE_NOW} hrefs={hrefs} />));
const row = (id: string) => container.querySelector<HTMLElement>(`[data-testid="activity-now-row"][data-row="${id}"]`);
const head = (id: string) => row(id)!.querySelector<HTMLElement>('button, a')!;
const rowIds = () => [...container.querySelectorAll('[data-testid="activity-now-row"]')].map(r => r.getAttribute('data-row'));

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The same Now with one row taken out of its group and put at the top of another. */
function moveRow(now: ActivityNow, id: string, toMission: string | null): ActivityNow {
  const r = now.groups.flatMap(g => g.rows).find(x => x.id === id)!;
  const groups: NowGroup[] = now.groups.map(g => ({ ...g, rows: g.rows.filter(x => x.id !== id) }));
  const to = groups.find(g => g.missionId === toMission)!;
  to.rows = [r, ...to.rows];
  return { ...now, groups: groups.filter(g => g.rows.length > 0) };
}

describe('a live update keeps what the reader opened', () => {
  it('a meaningful transition updates the row in place, with its evidence still open', () => {
    render(activityFixture(3).now);
    const before = row('fx-t34')!;
    act(() => head('fx-t34').click());
    expect(head('fx-t34').getAttribute('aria-expanded')).toBe('true');
    const lineBefore = before.textContent;
    // The repair pushed: step 3 → 4.
    render(activityFixture(4).now);
    expect(row('fx-t34')).toBe(before);
    expect(row('fx-t34')!.textContent).not.toBe(lineBefore);
    expect(head('fx-t34').getAttribute('aria-expanded')).toBe('true');
    expect(row('fx-t34')!.querySelector('[data-testid="activity-evidence"]')).not.toBeNull();
  });

  it('a row that moves to another group comes back open, its attempts and verification too', () => {
    const now = activityFixture(6).now;
    render(now);
    act(() => head('fx-t34').click());
    const toggle = (testid: string) => row('fx-t34')!.querySelector<HTMLButtonElement>(`[data-testid="${testid}"] button`)!;
    act(() => toggle('activity-verification').click());
    expect(toggle('activity-verification').getAttribute('aria-expanded')).toBe('true');
    render(moveRow(now, 'fx-t34', null));
    expect(row('fx-t34')!.closest('[data-testid="activity-group"]')!.getAttribute('data-mission')).toBe('standalone');
    expect(head('fx-t34').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('activity-verification').getAttribute('aria-expanded')).toBe('true');
  });

  it('a folded chain stays unfolded across an update', () => {
    const ctx = activityContextFixture();
    render(ctx.now);
    const chain = () => row('fx-chain')!.querySelector<HTMLButtonElement>('[data-testid="activity-derived"] button')!;
    act(() => chain().click());
    expect(chain().getAttribute('aria-expanded')).toBe('true');
    render(moveRow(ctx.now, 'fx-chain', null));
    expect(chain().getAttribute('aria-expanded')).toBe('true');
    expect(row('fx-chain')!.querySelectorAll('[data-testid="activity-derived-child"]')).toHaveLength(5);
  });

  it('History keeps its pages and shows a new delivery once', () => {
    const now = { groups: [], inMotion: 0, liveAgents: 0 };
    const history = Array.from({ length: 25 }, (_, i) => ({
      id: `ep-${i}`, title: `Delivery ${i}`, href: `/app/tasks/ep-${i}`, missionId: null, missionTitle: null,
      kind: 'landed' as const, repairRounds: 0, at: ACTIVITY_FIXTURE_NOW - i * 86_400_000,
      steps: [{ at: ACTIVITY_FIXTURE_NOW - i * 86_400_000 - 600_000, text: 'Build started', tone: 'muted' as const, void: false }],
    }));
    render(now, 'history', history);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="activity-history-more"]')!.click());
    expect(container.querySelectorAll('[data-testid="activity-episode"]')).toHaveLength(25);
    // A new delivery lands at the top of History; the pages already shown stay.
    const next = [{ ...history[0], id: 'ep-new', title: 'Delivery new', at: ACTIVITY_FIXTURE_NOW }, ...history];
    render(now, 'history', next);
    expect(container.querySelectorAll('[data-testid="activity-episode"]')).toHaveLength(26);
    expect([...container.querySelectorAll('[data-testid="activity-episode"]')].filter(e => e.textContent?.includes('Delivery new'))).toHaveLength(1);
  });
});

describe('a live update keeps focus and scroll', () => {
  it('focus stays on a row that is updated in place', () => {
    render(activityFixture(3).now);
    head('fx-t34').focus();
    render(activityFixture(4).now);
    expect(document.activeElement).toBe(head('fx-t34'));
  });

  it('focus follows a row whose element was replaced', () => {
    const now = activityFixture(4).now;
    render(now);
    head('fx-s07').focus();
    render(moveRow(now, 'fx-s07', null));
    expect(document.activeElement).toBe(head('fx-s07'));
  });

  it('focus the reader moved off the view is not taken back', async () => {
    const now = activityFixture(4).now;
    render(now);
    head('fx-s07').focus();
    head('fx-s07').blur();
    await Promise.resolve();
    render(moveRow(now, 'fx-s07', null));
    expect(document.activeElement).toBe(document.body);
  });

  it('the scroll position survives an update', () => {
    render(activityFixture(3).now);
    const scroller = container.querySelector<HTMLElement>('[data-testid="activity-scroll"]')!;
    scroller.scrollTop = 240;
    render(activityFixture(4).now);
    expect(container.querySelector('[data-testid="activity-scroll"]')).toBe(scroller);
    expect(scroller.scrollTop).toBe(240);
  });

  it('the anchor row is followed by how far it moved', () => {
    expect(anchorShift({ key: 'row:a', top: 120 }, () => 200)).toBe(80);
    expect(anchorShift({ key: 'row:a', top: 120 }, () => null)).toBe(0);
    expect(anchorShift(null, () => 200)).toBe(0);
  });
});

it('the visual QA fixture (`&data=states`) shows every state a row can carry', () => {
  render(activityStatesFixture().now);
  expect(container.querySelectorAll('[data-testid="activity-new"]').length).toBeGreaterThan(0);
  expect(row('fx-chain')!.querySelector('[data-testid="activity-derived"]')).not.toBeNull();
  const states = [...container.querySelectorAll('[data-testid="activity-verification"]')].map(v => v.getAttribute('data-state'));
  expect(new Set(states)).toEqual(new Set(['passed', 'failed', 'stale', 'unverified']));
  const known = [...container.querySelectorAll('[data-testid="activity-attribution"]')].map(a => a.getAttribute('data-known'));
  expect(known).toContain('true');
  expect(known).toContain('false');
});

describe('no delivery shows twice', () => {
  it('an update with an overlapping read (the same task twice) shows one card', () => {
    const { tasks, missions } = activityFixture(3);
    render(buildActivityNow({ tasks, missions, rules, now: ACTIVITY_FIXTURE_NOW }));
    const stale = tasks.find(t => t.id === 'fx-sa')!;
    const fresh: ActivityTaskInput = { ...stale, updatedAt: '2026-10-08T11:09:00.000Z' };
    render(buildActivityNow({ tasks: [...tasks, fresh], missions, rules, now: ACTIVITY_FIXTURE_NOW }));
    const ids = rowIds();
    expect(ids.filter(id => id === 'fx-sa')).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a row moving between groups is shown once, in its new group', () => {
    const now = activityFixture(4).now;
    render(now);
    render(moveRow(now, 'fx-t34', null));
    const ids = rowIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter(id => id === 'fx-t34')).toHaveLength(1);
  });

  it('a view handed the same row in two groups still shows it once', () => {
    const now = activityFixture(4).now;
    const r = now.groups.flatMap(g => g.rows).find(x => x.id === 'fx-t34')!;
    const doubled = { ...now, groups: now.groups.map(g => g.missionId === null ? { ...g, rows: [r, ...g.rows] } : g) };
    render(doubled);
    expect(rowIds().filter(id => id === 'fx-t34')).toHaveLength(1);
  });
});

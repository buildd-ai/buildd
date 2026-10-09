/**
 * Activity's filters across Now and History, as a person uses them: the
 * filters are kept when the route switches tabs (the page re-renders the same
 * client component, so its state survives), a filter that hides everything
 * says so and offers to clear it, and a failed load is never an empty list.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks' });

import { afterAll, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  usePathname: () => '/app/tasks',
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const rules = await import('@buildd/core/mission-helpers');
const { buildActivityHistory, buildActivityNow, latestTask } = await import('@/lib/activity-delivery');
const { ACTIVITY_FIXTURE_NOW, activityScaleFixture } = await import('../../dev/fixtures/activity-delivery-fixtures');
const { default: ActivityView } = await import('./ActivityView');
type Props = import('./ActivityView').ActivityViewProps;

const hrefs = { now: '/app/tasks', history: '/app/tasks?view=history' };
const iso = (min: number) => new Date(ACTIVITY_FIXTURE_NOW - min * 60_000).toISOString();

/** Live work with no retries, and a History that has retried deliveries: the Oct 9 shape. */
function noRetriesNow() {
  const tasks = [
    { id: 'a', title: 'feat: live work', status: 'in_progress', taskClass: 'work', missionId: null, createdAt: iso(20), updatedAt: iso(1), workers: [{ status: 'running', name: 'runner-a', startedAt: iso(20), updatedAt: iso(1) }] },
    { id: 'b', title: 'fix: landed after a retry', status: 'completed', taskClass: 'work', missionId: null, createdAt: iso(300), updatedAt: iso(200), workers: [{ status: 'completed', prUrl: 'https://github.com/example/project/pull/7', prNumber: 7, mergedAt: iso(200), startedAt: iso(300), completedAt: iso(250), updatedAt: iso(200) }] },
    { id: 'b-r1', title: '[builder · after CI #1] fix: landed after a retry', status: 'completed', taskClass: 'attempt', parentTaskId: 'b', missionId: null, createdAt: iso(240), updatedAt: iso(220), workers: [{ status: 'completed', startedAt: iso(240), completedAt: iso(220), updatedAt: iso(220), lastCommitSha: 'abcdef0123' }] },
  ];
  const args = { tasks, missions: [], rules };
  return { now: buildActivityNow({ ...args, now: ACTIVITY_FIXTURE_NOW }), history: buildActivityHistory(args), latest: latestTask(tasks, rules) };
}

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterAll(() => act(() => root.unmount()));

async function show(props: Partial<Props> & Pick<Props, 'mode' | 'now' | 'history'>) {
  await act(async () => { root.render(<ActivityView latest={null} nowMs={ACTIVITY_FIXTURE_NOW} hrefs={hrefs} {...props} />); });
}
const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)!;
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });

describe('ActivityView filters across Now and History', () => {
  it('Had retries hides all of Now: says so, says what is there, and clears', async () => {
    const d = noRetriesNow();
    await show({ mode: 'now', ...d });
    await click(button('Had retries'));
    expect(q('activity-now-row')).toBeNull();
    expect(q('activity-filtered-empty')?.textContent).toContain('Nothing in motion matches these filters. 1 delivery in Now.');
    expect(container.textContent).not.toContain('Nothing in motion. Finished work is in History.');
    // The counts are the unfiltered truth.
    expect(q('activity-counts')?.textContent).toBe('1 delivery in motion · 1 agent working');

    // Now → History: the same component re-renders, so the filter is kept and History shows the retried delivery.
    await show({ mode: 'history', ...d });
    expect(button('Had retries').getAttribute('aria-pressed')).toBe('true');
    expect([...container.querySelectorAll('[data-testid="activity-episode"]')].map(e => e.textContent)).toEqual([expect.stringContaining('fix: landed after a retry')]);

    // And back: still filtered, still honest; Clear filters brings the rows back.
    await show({ mode: 'now', ...d });
    expect(q('activity-filtered-empty')).not.toBeNull();
    await click(q('activity-clear-filters')!);
    expect(button('Any state').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('[data-testid="activity-now-row"]')).toHaveLength(1);
  });

  it('a History filter that matches nothing names the episodes it hides', async () => {
    const d = noRetriesNow();
    await show({ mode: 'history', ...d, history: d.history.filter(e => e.repairRounds === 0) });
    await click(button('Had retries'));
    expect(q('activity-filtered-empty')?.textContent).toContain('No episodes match these filters. 1 episode in History.');
    await click(q('activity-clear-filters')!);
    expect(container.querySelectorAll('[data-testid="activity-episode"]')).toHaveLength(1);
  });

  it('genuinely empty is not filtered-empty and offers nothing to clear', async () => {
    const empty = { groups: [], inMotion: 0, liveAgents: 0 };
    await show({ mode: 'now', now: empty, history: [] });
    expect(q('activity-empty')?.textContent).toBe('Nothing in motion. Finished work is in History.');
    await show({ mode: 'history', now: empty, history: [] });
    expect(q('activity-empty')?.textContent).toBe('No deliveries in the last 30 days.');
    expect(q('activity-clear-filters')).toBeNull();
  });

  it('a failed load is a failure, not "Nothing in motion" and not zero counts', async () => {
    for (const mode of ['now', 'history'] as const) {
      await show({ mode, now: { groups: [], inMotion: 0, liveAgents: 0 }, history: [], loadError: true });
      expect(q('activity-load-error')?.getAttribute('role')).toBe('alert');
      expect(q('activity-counts')).toBeNull();
      expect(q('activity-empty')).toBeNull();
      expect(container.textContent).not.toContain('Nothing in motion');
    }
  });

  it('a busy workspace: Had retries finds the live old root in Now and many episodes in History', async () => {
    const d = activityScaleFixture();
    await show({ mode: 'now', now: d.now, history: d.history, initialFilters: { outcome: 'retries' } });
    expect(q('activity-counts')?.textContent).toMatch(/^[1-9]\d* deliver(y|ies) in motion · 1 agent working$/);
    const rows = [...container.querySelectorAll('[data-testid="activity-now-row"]')].map(r => r.textContent ?? '');
    expect(rows.some(t => t.includes('fix: long-running migration backfill'))).toBe(true);
    await show({ mode: 'history', now: d.now, history: d.history, initialFilters: { outcome: 'retries' } });
    expect(container.querySelectorAll('[data-testid="activity-episode"]').length).toBeGreaterThan(10);
  });
});

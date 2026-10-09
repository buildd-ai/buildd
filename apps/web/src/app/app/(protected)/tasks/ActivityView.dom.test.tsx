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

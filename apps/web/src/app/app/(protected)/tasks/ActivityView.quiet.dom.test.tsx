/**
 * Quiet Now (spec 9430a28f R-24, R-26): nothing in motion is one quiet
 * block with at most one pointer to the last merge, never a zero Pipeline
 * or a second list of finished missions. Fixtures are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks' });
import { afterEach, describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { buildActivityNow, type ActivityTaskInput } from '@/lib/activity-delivery';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ActivityView } = await import('./ActivityView');

const hrefs = { now: '/app/tasks', history: '/app/tasks?view=history' };
const nowMs = Date.parse('2026-11-03T12:00:00Z');
const quietNow = buildActivityNow({ tasks: [], missions: [], rules, now: nowMs });
const lastMerged = { id: 't-merged', title: 'feat(missions): outcome hero', mergedAt: nowMs - 3 * 3_600_000 };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function mount(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(el));
}
afterEach(() => { act(() => root.unmount()); container.remove(); });
const q = (sel: string) => container.querySelector(sel);

describe('Activity Now: quiet state', () => {
  it('AC-24: nothing in motion renders the quiet block, no Pipeline, stages, columns or rail', () => {
    mount(<ActivityView mode="now" now={quietNow} history={[]} nowMs={nowMs} hrefs={hrefs} lastMerged={lastMerged} />);
    const quiet = q('[data-testid="activity-quiet"]')!;
    expect(quiet).not.toBeNull();
    expect(quiet.textContent).toContain('Nothing in motion');
    for (const sel of ['[data-testid="pipeline"]', '[data-testid="pipeline-row"]', '[data-testid="activity-stage"]', '[data-testid="activity-column"]', '[data-testid="activity-rail"]', '[data-testid="you-strip"]', '[data-testid="activity-empty"]']) {
      expect(q(sel)).toBeNull();
    }
    const pointer = q('[data-testid="activity-quiet-last"]')!;
    expect(pointer.textContent).toContain('Last merged');
    expect(pointer.textContent).toContain('3h ago');
    expect(pointer.querySelector('a')!.getAttribute('href')).toBe('/app/tasks/t-merged');
    const links = [...quiet.querySelectorAll('[data-testid="activity-quiet-links"] a')].map(a => a.getAttribute('href'));
    expect(links).toEqual(['/app/tasks?view=history', '/app/missions']);
  });

  it('AC-24: with no merge in the window there is no pointer, the links stay', () => {
    mount(<ActivityView mode="now" now={quietNow} history={[]} nowMs={nowMs} hrefs={hrefs} lastMerged={null} />);
    expect(q('[data-testid="activity-quiet"]')).not.toBeNull();
    expect(q('[data-testid="activity-quiet-last"]')).toBeNull();
    expect(q('[data-testid="activity-quiet-links"]')).not.toBeNull();
  });

  it('AC-24: a failed load shows the error, never the quiet block', () => {
    mount(<ActivityView mode="now" now={quietNow} history={[]} nowMs={nowMs} hrefs={hrefs} loadError lastMerged={lastMerged} />);
    expect(q('[data-testid="activity-load-error"]')).not.toBeNull();
    expect(q('[data-testid="activity-quiet"]')).toBeNull();
  });

  it('AC-24: work in motion keeps the Pipeline and rows, and no quiet block', () => {
    const iso = new Date(nowMs).toISOString();
    const building: ActivityTaskInput = { id: 'b', title: 'Building work', status: 'in_progress', missionId: null, createdAt: iso, updatedAt: iso, workers: [{ status: 'running' }] };
    mount(<ActivityView mode="now" now={buildActivityNow({ tasks: [building], missions: [], rules, now: nowMs })} history={[]} nowMs={nowMs} hrefs={hrefs} lastMerged={lastMerged} />);
    expect(q('[data-testid="activity-quiet"]')).toBeNull();
    expect(q('[data-testid="pipeline"]')).not.toBeNull();
    expect(q('[data-testid="activity-now-row"]')).not.toBeNull();
  });

  it('AC-24: only queued work is still work: the Pipeline and the queued group show', () => {
    const iso = new Date(nowMs).toISOString();
    const queued: ActivityTaskInput = { id: 'w', title: 'Waiting task', status: 'pending', missionId: null, createdAt: iso, updatedAt: iso, workers: [] };
    mount(<ActivityView mode="now" now={buildActivityNow({ tasks: [queued], missions: [], rules, now: nowMs })} history={[]} nowMs={nowMs} hrefs={hrefs} />);
    expect(q('[data-testid="activity-quiet"]')).toBeNull();
    expect(q('[data-testid="activity-stage"][data-stage="queued"]')).not.toBeNull();
  });

  it('AC-26: the quiet block is a pointer, not an archive: one delivery link and no mission rows', () => {
    mount(<ActivityView mode="now" now={quietNow} history={[]} nowMs={nowMs} hrefs={hrefs} lastMerged={lastMerged} />);
    const quiet = q('[data-testid="activity-quiet"]')!;
    const taskLinks = [...quiet.querySelectorAll('a')].filter(a => /^\/app\/tasks\//.test(a.getAttribute('href') ?? ''));
    expect(taskLinks).toHaveLength(1);
    expect(quiet.querySelector('[data-testid="portfolio-done-row"], [data-testid="activity-rail-mission"], [data-testid="activity-episode"]')).toBeNull();
  });
});

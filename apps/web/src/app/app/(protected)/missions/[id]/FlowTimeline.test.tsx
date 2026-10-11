/**
 * The mission Flow tab (happy-dom), over the prototype's two missions
 * (docs/specs/mission-flow-timeline.md):
 * - one row per task, the critical-path sentence above it;
 * - every gate is an edge, faint until a selection lights it the strip's way;
 * - above eight tasks, merged tasks share one row until it is opened;
 * - everything horizontal is a percentage: no width-dependent layout, no
 *   horizontal scroll;
 * - it says nothing about estimates, and there is no Graph/Timeline toggle.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1?layout=flow' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: FlowTimeline } = await import('./FlowTimeline');
const { missionFlowFixture } = await import('../../../dev/fixtures/mission-flow-fixtures');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(variant: 'small' | 'wide') {
  const f = missionFlowFixture(variant, Date.now());
  act(() => {
    root.render(<FlowTimeline model={f.model} sameFiles={f.sameFiles} expectedMinutes={f.expectedMinutes} missionId="m1" />);
  });
  return f;
}

const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="flow-row"]')];
const row = (tick: string) => rows().find(r => r.dataset.tick === tick)!;
const litEdges = () => [...container.querySelectorAll('[data-testid="flow-edges"] path[data-on]')].map(p => `${p.getAttribute('data-from')}>${p.getAttribute('data-to')}`).sort();
const allEdges = () => container.querySelectorAll('[data-testid="flow-edges"] path');

describe('FlowTimeline', () => {
  it('draws one row per task and says what sets the finish', () => {
    mount('small');
    expect(rows().map(r => r.dataset.tick)).toEqual(['01', '02', '03', '04', '05', '06', '07']);
    expect(container.querySelector('[data-testid="flow-critical-path"]')?.textContent).toBe('Finish is set by 04 (building), then 06 → 07.');
  });

  it('opens on the task setting the finish, its downstream edges lit', () => {
    mount('small');
    expect(row('04').getAttribute('aria-pressed')).toBe('true');
    expect(litEdges()).toEqual(['04>06', '06>07']);
  });

  it('every gate is drawn; selecting a held task lights what holds it', () => {
    mount('small');
    // 02←01, 03←02, 04←02, 05←03, 06←03, 06←04, 07←05, 07←06
    expect(allEdges().length).toBe(8);
    act(() => row('06').click());
    expect(row('06').getAttribute('aria-pressed')).toBe('true');
    expect(litEdges()).toEqual(['03>06', '04>06']);
    act(() => row('01').click());
    expect(litEdges()).toEqual([]);
  });

  it('outlines the unlanded tasks on the critical path only', () => {
    mount('small');
    const crit = [...container.querySelectorAll('[data-bar][data-critical]')].map(b => b.closest<HTMLElement>('[data-testid="flow-row"]')?.dataset.tick);
    expect(crit).toEqual(['04', '06', '07']);
  });

  it('above eight tasks, merged tasks share one row until it is opened', () => {
    mount('wide');
    const merged = container.querySelector<HTMLButtonElement>('[data-testid="flow-merged-row"]');
    expect(merged?.textContent).toContain('3 merged');
    expect(rows().length).toBe(10);
    act(() => merged!.click());
    expect(container.querySelector('[data-testid="flow-merged-row"]')).toBeNull();
    expect(rows().length).toBe(13);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="flow-fold-merged"]')!.click());
    expect(rows().length).toBe(10);
  });

  it('draws the same-files wait Buildd added, dotted', () => {
    mount('wide');
    const soft = container.querySelectorAll('[data-testid="flow-edges"] path[data-kind="same_files"]');
    expect(soft.length).toBe(1);
    expect(soft[0].getAttribute('stroke-dasharray')).toBe('1 3');
  });

  it('rows never grow horizontally: positions are percentages, nothing scrolls sideways', () => {
    const f = missionFlowFixture('wide', Date.now());
    const html = renderToStaticMarkup(<FlowTimeline model={f.model} sameFiles={f.sameFiles} expectedMinutes={f.expectedMinutes} missionId="m1" />);
    const styles = [...html.matchAll(/style="([^"]*)"/g)].map(m => m[1]);
    expect(styles.length).toBeGreaterThan(0);
    for (const s of styles) {
      for (const [, prop, value] of s.matchAll(/(?:^|;)\s*(left|width):([^;]+)/g)) {
        expect(`${prop}:${value}`).toMatch(/%$/);
      }
    }
    expect(html).not.toMatch(/overflow-x-(auto|scroll)|min-w-\[\d{3,}px\]|w-\[\d{3,}px\]/);
    expect(html).toContain('preserveAspectRatio="none"');
  });

  it('says nothing about estimates and has no Graph/Timeline toggle', () => {
    mount('wide');
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/estimat|p80|forecast/i);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(text).not.toMatch(/\bGraph\b/);
  });

  it('the selected task opens in the task sheet from its card', () => {
    const f = mount('small');
    const open = container.querySelector<HTMLAnchorElement>('[data-testid="focus-card"] a[data-task-id]');
    expect(open?.dataset.taskId).toBe(f.idOf(4));
  });
});

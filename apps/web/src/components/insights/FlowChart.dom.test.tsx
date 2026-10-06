import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });
import { afterEach, expect, it } from 'bun:test';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { FlowChart } = await import('./FlowChart');
const { sampleFlowSeries } = await import('@/app/app/(protected)/health/insights/sample-series');
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterEach(() => act(() => root.render(null)));
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function render() { act(() => root.render(<FlowChart series={sampleFlowSeries('7d')} taskHref={k => `/app/tasks/${k}`} />)); }
it('keeps the persistent key to four semantic groups and release lines off by default', () => {
  render();
  expect(q('flow-legend')!.querySelectorAll('li')).toHaveLength(4);
  expect(q('flow-legend')!.textContent).not.toContain('average tasks');
  expect(document.querySelectorAll('[data-testid="flow-release-line"]')).toHaveLength(0);
});
it('keyboard selection anchors a summary, expands task details, and keeps its highlight after closing', () => {
  render();
  const svg = container.querySelector('svg')!;
  act(() => svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(q('flow-summary')).not.toBeNull();
  expect(q('flow-picked')).toBeNull();
  act(() => q('flow-details-trigger')!.click());
  expect(q('flow-picked')!.getAttribute('aria-modal')).toBe('false');
  expect(q('flow-selection')).not.toBeNull();
  expect(q('flow-picked')!.querySelector('a')?.getAttribute('href')).toStartWith('/app/tasks/');
  act(() => q('flow-expand')!.click());
  // happy-dom's default 1024px width is md+, so the contextual sheet renders inline
  // (never overlaying the "Agent time by role" card below it) rather than as a
  // viewport-fixed bottom sheet.
  expect(q('flow-picked')!.className).toContain('max-h-[55vh]');
  act(() => q('flow-picked')!.querySelector<HTMLElement>('[aria-label="Close"]')!.click());
  expect(q('flow-picked')).toBeNull();
  expect(q('flow-selection')).not.toBeNull();
});
it('the task-detail sheet renders inline next to the chart at desktop width, never as a viewport-fixed overlay that could cover sibling cards', () => {
  render();
  const svg = container.querySelector('svg')!;
  act(() => svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  act(() => q('flow-details-trigger')!.click());
  const dialog = q('flow-picked')!;
  // Rendered in place inside `container` (not portaled to <body>), so it can never
  // land on top of unrelated content elsewhere on the page.
  expect(container.contains(dialog)).toBe(true);
  expect(dialog.closest('.fixed')).toBeNull();
});

it('release annotations are selectable and show exactly one selected event hairline', () => {
  render();
  act(() => container.querySelector<SVGElement>('[data-testid="flow-release"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(q('flow-summary')!.textContent).toContain('Release');
  expect(document.querySelectorAll('[data-testid="flow-release-line"]')).toHaveLength(1);
});

it('a touch picks a point before opening details, and stages remain available for drill-down', () => {
  render();
  const svg = container.querySelector('svg')!;
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 220, right: 360, bottom: 220, x: 0, y: 0, toJSON() {} });
  act(() => svg.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: 180, clientY: 90, bubbles: true })));
  expect(q('flow-summary')).not.toBeNull();
  expect(q('flow-picked')).toBeNull();
  act(() => q('flow-details-trigger')!.click());
  const select = q('flow-picked')!.querySelector<HTMLElement>('[role=combobox]')!;
  act(() => select.click());
  expect(document.querySelectorAll('[role=option]')).toHaveLength(6);
  act(() => select.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  act(() => select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(q('flow-summary')!.textContent).toContain('Failed or abandoned');
  expect(q('flow-selection')).not.toBeNull();
});

it('shows bounded band composition and a filtered task-list link without explanatory prose', () => {
  render();
  const svg = container.querySelector('svg')!;
  act(() => svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  act(() => q('flow-details-trigger')!.click());
  expect(q('flow-breakdown')!.textContent).toContain('Workspace');
  expect(q('flow-breakdown')!.textContent).toContain('Outcome');
  expect(q('flow-picked')!.querySelectorAll('a[href^="/app/tasks/"]').length).toBeLessThanOrEqual(5);
  const href = q('flow-task-list')!.getAttribute('href')!;
  expect(href).toContain('band=');
  expect(href).toContain('at=');
  expect(container.textContent).not.toContain('About this chart');
  expect(container.textContent).not.toContain('Ticks above the plot');
  act(() => q('flow-expand')!.click());
  expect(container.textContent).not.toContain('average tasks with an agent');
});

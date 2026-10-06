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
  expect(q('flow-picked')!.className).toContain('h-[55dvh]');
  act(() => q('flow-picked')!.querySelector<HTMLElement>('[aria-label="Close"]')!.click());
  expect(q('flow-picked')).toBeNull();
  expect(q('flow-selection')).not.toBeNull();
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
  const select = q('flow-picked')!.querySelector<HTMLSelectElement>('select')!;
  expect(select.options).toHaveLength(6);
  act(() => { select.value = 'lost'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(q('flow-summary')!.textContent).toContain('Failed or abandoned');
  expect(q('flow-selection')).not.toBeNull();
});

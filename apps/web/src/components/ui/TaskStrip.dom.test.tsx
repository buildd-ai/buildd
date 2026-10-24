/**
 * TaskStrip and Segmented, mounted (happy-dom): selection by click and by
 * keyboard. Runs in its own process (scripts/run-unit-tests.ts).
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TaskStrip } = await import('./TaskStrip');
const { default: Segmented } = await import('./Segmented');

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

function Strip() {
  const [sel, setSel] = useState('b');
  return <TaskStrip cells={[{ id: 'a', state: 'landed' }, { id: 'b', state: 'running' }, { id: 'c', state: 'blocked' }]} selectedId={sel} onSelect={setSel} />;
}
const pressed = () => [...container.querySelectorAll('button[data-id]')].find(b => b.getAttribute('aria-pressed') === 'true')?.getAttribute('data-id');

describe('TaskStrip lg interaction', () => {
  it('selects by click', () => {
    act(() => root.render(<Strip />));
    act(() => (container.querySelector('button[data-id="c"]') as HTMLButtonElement).click());
    expect(pressed()).toBe('c');
  });

  it('← → step the selection and wrap; only the selected cell is in the tab order', () => {
    act(() => root.render(<Strip />));
    const b = container.querySelector('button[data-id="b"]') as HTMLButtonElement;
    expect(b.tabIndex).toBe(0);
    act(() => { b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(pressed()).toBe('c');
    const c = container.querySelector('button[data-id="c"]') as HTMLButtonElement;
    act(() => { c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(pressed()).toBe('a');
    expect((container.querySelector('button[data-id="a"]') as HTMLButtonElement).tabIndex).toBe(0);
  });
});

describe('Segmented', () => {
  function Seg() {
    const [v, setV] = useState<'state' | 'effort'>('state');
    return <Segmented label="View" value={v} onChange={setV} items={[{ value: 'state', label: 'State' }, { value: 'effort', label: 'Effort' }]} />;
  }
  const checked = () => container.querySelector('[role="radio"][aria-checked="true"]')?.textContent;

  it('switches by click and by arrow key', () => {
    act(() => root.render(<Seg />));
    expect(checked()).toBe('State');
    act(() => (container.querySelectorAll('[role="radio"]')[1] as HTMLButtonElement).click());
    expect(checked()).toBe('Effort');
    act(() => { container.querySelector('[role="radiogroup"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(checked()).toBe('State');
  });
});

describe('TaskStrip grouped phone cell width (R-4)', () => {
  const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  const origWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 358 });
    window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
    if (origWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', origWidth);
  });

  for (const [count, split] of [[15, [10, 5]], [23, [10, 10, 3]]] as const) {
    it(`${count} cells: every row uses the same fixed cell track`, () => {
      const cells = Array.from({ length: count }, (_, i) => ({ id: `c${i}`, state: (i < count - 3 ? 'landed' : 'queued') as 'landed' | 'queued' }));
      const groups = [{ key: 'done', ids: cells.slice(0, count - 3).map(c => c.id) }, { key: 'rest', ids: cells.slice(count - 3).map(c => c.id) }];
      act(() => root.render(<TaskStrip cells={cells} groups={groups} ticks={false} />));
      const rows = [...container.querySelectorAll('[data-testid="task-strip-cells"]')] as HTMLElement[];
      expect(rows.length).toBeGreaterThan(1);
      const widths = new Set<string>();
      for (const r of rows) {
        const cell = r.style.getPropertyValue('--cell');
        expect(cell).toMatch(/^\d+(\.\d+)?px$/);
        widths.add(cell);
        expect(r.style.gridTemplateColumns).toContain('var(--cell)');
      }
      expect(widths.size).toBe(1);
      expect(rows.map(r => r.querySelectorAll('button').length).reduce((a, b) => a + b, 0)).toBe(count);
      void split;
    });
  }
});

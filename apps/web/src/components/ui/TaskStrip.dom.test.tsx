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

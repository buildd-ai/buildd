/**
 * Disclosure, mounted (happy-dom): aria wiring, uncontrolled/controlled
 * toggling, and the `data-task-id` click guard.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Disclosure } = await import('./Disclosure');

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

const toggle = () => container.querySelector('button')!;

describe('Disclosure', () => {
  it('starts closed, wires aria-controls to the panel, and mounts children only when open', () => {
    act(() => root.render(<Disclosure summary="Logs" count={4}><p data-testid="body">log</p></Disclosure>));
    const btn = toggle();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(btn.getAttribute('aria-controls')!);
    expect(panel).not.toBeNull();
    expect(panel!.hidden).toBe(true);
    expect(container.querySelector('[data-testid="body"]')).toBeNull();
    expect(btn.textContent).toContain('4');

    act(() => btn.click());
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(panel!.hidden).toBe(false);
    expect(container.querySelector('[data-testid="body"]')).not.toBeNull();
  });

  it('is a 44px tap target below md', () => {
    act(() => root.render(<Disclosure summary="x">y</Disclosure>));
    expect(toggle().className).toContain('min-h-11');
  });

  it('honours defaultOpen', () => {
    act(() => root.render(<Disclosure summary="x" defaultOpen>y</Disclosure>));
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('controlled: reports the next state and follows the open prop', () => {
    const calls: boolean[] = [];
    act(() => root.render(<Disclosure summary="x" open={false} onOpenChange={o => calls.push(o)}>y</Disclosure>));
    act(() => toggle().click());
    expect(calls).toEqual([true]);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('inside a data-task-id row the toggle does not open the row', () => {
    let rowClicks = 0;
    act(() =>
      root.render(
        <div data-task-id="t1" onClick={() => rowClicks++}>
          <Disclosure summary="x">y</Disclosure>
        </div>,
      ),
    );
    act(() => toggle().click());
    expect(rowClicks).toBe(0);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('outside a task row the click still bubbles', () => {
    let clicks = 0;
    act(() => root.render(<div onClick={() => clicks++}><Disclosure summary="x">y</Disclosure></div>));
    act(() => toggle().click());
    expect(clicks).toBe(1);
  });
});

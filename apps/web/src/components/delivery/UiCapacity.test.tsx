import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: UiCapacity } = await import('./UiCapacity');

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

describe('UiCapacity', () => {
  it('renders capacity metrics', () => {
    const chart = Array.from({ length: 24 }, (_, i) => (i % 3) * 50);

    act(() =>
      root.render(
        <UiCapacity
          running={3}
          total={9}
          runnersOnline={2}
          totalRunners={3}
          sessions={2}
          peak={8}
          average={4.6}
          chart={chart}
        />
      )
    );

    expect(container.textContent).toContain('3/9');
    expect(container.textContent).toContain('Running');
    expect(container.textContent).toContain('2/3');
    expect(container.textContent).toContain('Runners');
    expect(container.textContent).toContain('2');
    expect(container.textContent).toContain('Sessions');
    expect(container.textContent).toContain('8');
    expect(container.textContent).toContain('Peak');
    expect(container.textContent).toContain('4.6');
    expect(container.textContent).toContain('Avg');
  });

  it('renders window picker with 24h, 7d, 30d buttons', () => {
    const chart = Array.from({ length: 24 }, () => 50);

    act(() =>
      root.render(
        <UiCapacity
          running={3}
          total={9}
          runnersOnline={2}
          totalRunners={3}
          sessions={2}
          peak={8}
          average={4.6}
          chart={chart}
        />
      )
    );

    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(3);
    expect(buttons[0].textContent).toBe('24h');
    expect(buttons[1].textContent).toBe('7d');
    expect(buttons[2].textContent).toBe('30d');
  });

  it('calls onWindowChange when a window button is clicked', () => {
    const chart = Array.from({ length: 24 }, () => 50);
    let called = false;
    let window = '';

    act(() =>
      root.render(
        <UiCapacity
          running={3}
          total={9}
          runnersOnline={2}
          totalRunners={3}
          sessions={2}
          peak={8}
          average={4.6}
          chart={chart}
          onWindowChange={(w) => {
            called = true;
            window = w;
          }}
        />
      )
    );

    const button7d = container.querySelectorAll('button')[1];
    act(() => button7d.click());

    expect(called).toBe(true);
    expect(window).toBe('7d');
  });

  it('renders chart with 24 bars', () => {
    const chart = Array.from({ length: 24 }, (_, i) => (i % 3) * 50);

    act(() =>
      root.render(
        <UiCapacity
          running={3}
          total={9}
          runnersOnline={2}
          totalRunners={3}
          sessions={2}
          peak={8}
          average={4.6}
          chart={chart}
        />
      )
    );

    const bars = container.querySelectorAll('span[style*="border-radius: 1px 1px 0 0"]');
    expect(bars.length).toBe(24);
  });

  it('distinguishes idle (low value) and busy (high value) bars by color', () => {
    const chart = [20, 100, 20, 100]; // Low, high, low, high pattern

    act(() =>
      root.render(
        <UiCapacity
          running={3}
          total={9}
          runnersOnline={2}
          totalRunners={3}
          sessions={2}
          peak={8}
          average={4.6}
          chart={chart}
        />
      )
    );

    const bars = container.querySelectorAll('span[style*="border-radius: 1px 1px 0 0"]');

    const getBackground = (bar: Element) => {
      const style = bar.getAttribute('style') || '';
      const match = style.match(/background:\s*([^;]+)/);
      return match ? match[1] : '';
    };

    const bar0 = getBackground(bars[0]);
    const bar1 = getBackground(bars[1]);

    expect(bar0).not.toBe(bar1); // Should have different colors
  });
});

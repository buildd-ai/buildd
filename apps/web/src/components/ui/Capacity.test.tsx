import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Capacity, runnersLine, peakLine } = await import('./Capacity');

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

const base = {
  running: 3,
  total: 9,
  runnersOnline: 2,
  totalRunners: 3,
  sessions: 2,
  peak: 5,
  average: 3,
  chart: [0, 2, 5, 0, 3],
};
const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent;
const render = (props: Partial<typeof base> & { onWindowChange?: (w: string) => void } = {}) =>
  act(() => root.render(<Capacity {...base} {...props} />));

describe('Capacity (AC-9, R-13)', () => {
  it('renders the three spec lines', () => {
    render();
    expect(text('capacity-headline')).toBe('3 of 9 slots in use');
    expect(text('capacity-runners')).toBe('2 of 3 runners online · plus 2 Claude Code sessions');
    expect(text('capacity-peak')).toBe('Peak 5 · average 3 · over 24h');
  });

  it('never sums sessions into slots', () => {
    render();
    expect(text('capacity-headline')).not.toContain('5 of');
  });

  it('handles one session and zero sessions', () => {
    expect(runnersLine(1, 1, 1)).toBe('1 of 1 runner online · plus 1 Claude Code session');
    expect(runnersLine(2, 3, 0)).toBe('2 of 3 runners online');
    render({ sessions: 0 });
    expect(text('capacity-runners')).toBe('2 of 3 runners online');
  });

  it('formats the peak line for any window', () => {
    expect(peakLine(8, 4.6, '30d')).toBe('Peak 8 · average 4.6 · over 30d');
  });

  it('picks a window, reports it and updates the peak line', () => {
    let got = '';
    render({ onWindowChange: w => (got = w) });
    const radios = container.querySelectorAll('[role="radio"]');
    expect(Array.from(radios).map(r => r.textContent)).toEqual(['24h', '7d', '30d']);
    act(() => (radios[1] as HTMLElement).click());
    expect(got).toBe('7d');
    expect(text('capacity-peak')).toBe('Peak 5 · average 3 · over 7d');
  });

  it('draws one bar per bucket; idle (0 busy slots) differs by pattern and outline, not colour alone', () => {
    render();
    const chart = container.querySelector('[data-testid="capacity-chart"]')!;
    expect(chart.getAttribute('role')).toBe('img');
    expect(chart.getAttribute('aria-label')).toContain('2 idle stretches');
    const bars = Array.from(chart.children) as HTMLElement[];
    expect(bars.length).toBe(5);
    const idle = bars.filter(b => b.dataset.idle === 'true');
    expect(idle.length).toBe(2);
    expect(idle[0].className).toContain('border-dashed');
    expect(idle[0].getAttribute('style')).toContain('repeating-linear-gradient');
    expect(bars[1].dataset.idle).toBe('false');
    expect(bars[1].getAttribute('style')).not.toContain('repeating-linear-gradient');
  });

  it('does not call a low but non-zero bar idle', () => {
    render({ chart: [1, 9] });
    const bars = Array.from(container.querySelector('[data-testid="capacity-chart"]')!.children) as HTMLElement[];
    expect(bars.every(b => b.dataset.idle === 'false')).toBe(true);
  });

  it('uses tokens, not hex colours', () => {
    render();
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});

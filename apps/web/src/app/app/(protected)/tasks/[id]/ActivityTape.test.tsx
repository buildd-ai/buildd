import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityTape, visibleAxisLabels } from './WorkerActivityTimeline';

// Regression (demo capture, live task): the tape's axis had no time at its right
// edge, so it read as ending at the last progress flag (3:41) while ELAPSED said
// 4:21. The right edge now prints the span it covers.
describe('ActivityTape axis', () => {
  const T0 = 1_000_000;
  const milestones = [
    { type: 'action' as const, label: 'Edited a.ts', ts: T0 + 60_000 },
    { type: 'status' as const, label: 'Halfway', progress: 45, ts: T0 + 221_000 },
  ];

  it('a live tape ends at the elapsed time, marked now', () => {
    const html = renderToStaticMarkup(<ActivityTape milestones={milestones} startMs={T0} nowMs={T0 + 261_000} live />);
    const end = html.match(/data-testid="worker-activity-axis-end"[^>]*>([\s\S]*?)<\/span><\/div>/);
    expect(end).not.toBeNull();
    expect(html).not.toContain('45%');
    expect(html).toContain('Halfway');
    expect(end![1]).toContain('4:21');
    expect(end![1]).toContain('now');
  });

  it('a finished tape ends at its last event time, without "now"', () => {
    const html = renderToStaticMarkup(<ActivityTape milestones={milestones} startMs={T0} nowMs={T0 + 221_000} live={false} />);
    const end = html.match(/data-testid="worker-activity-axis-end"[^>]*>([\s\S]*?)<\/span><\/div>/);
    expect(end).not.toBeNull();
    expect(end![1]).toContain('3:41');
    expect(end![1]).not.toContain('now');
  });
});

// Regression (390px screenshot): labels hid by strip width, so the 0:00 and 0:14
// labels still printed on top of each other. They now give way by pixel gap.
describe('visibleAxisLabels', () => {
  const axis = ['0:00', '0:14', '0:28', '0:42'];
  const gapOk = (w: number, shown: boolean[]) => {
    const xs = shown.map((s, i) => (s ? [(w * i) / 4, (w * i) / 4 + axis[i].length * 7] : null)).filter(Boolean) as number[][];
    for (let i = 1; i < xs.length; i++) expect(xs[i][0] - xs[i - 1][1]).toBeGreaterThanOrEqual(12);
  };

  it('shows only the start label before the strip is measured', () => {
    expect(visibleAxisLabels(null, axis, '0:56', true)).toEqual([true, false, false, false]);
  });

  it('never leaves two shown labels closer than the minimum gap', () => {
    for (const w of [60, 100, 140, 200, 290, 340, 450, 800]) {
      const shown = visibleAxisLabels(w, axis, '0:56', true);
      expect(shown[0]).toBe(true);
      gapOk(w, shown);
    }
  });

  it('hides the 25% label on a strip too narrow to separate it from the start', () => {
    expect(visibleAxisLabels(100, axis, '0:56', false)[1]).toBe(false);
  });

  it('shows every label on a wide strip', () => {
    expect(visibleAxisLabels(1000, axis, '0:56', true)).toEqual([true, true, true, true]);
  });
});

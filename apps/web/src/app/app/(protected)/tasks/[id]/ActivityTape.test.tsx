import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityTape } from './WorkerActivityTimeline';

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

// Regression (360px screenshot, run-activity fixture): at ~290px the 75% label
// sat under the end label and printed "30:40:00". Below md it gives way.
describe('ActivityTape axis below md', () => {
  it('keeps the start label always and hides the others until the strip is wide enough', () => {
    const T0 = 1_700_000_000_000;
    const html = renderToStaticMarkup(<ActivityTape milestones={[{ type: 'action', label: 'Edit a.ts', ts: T0 + 60_000 } as never]} startMs={T0} nowMs={T0 + 2_400_000} live />);
    const labels = [...html.matchAll(/<span data-axis="(\d)" class="([^"]+)"/g)].map(m => [m[1], m[2]]);
    expect(labels.map(l => l[0])).toEqual(['0', '1', '2', '3']);
    expect(labels[0][1]).not.toContain('hidden');
    for (const [, cls] of labels.slice(1)) expect(cls).toContain('hidden @');
  });
});

import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { OccupancyPlot, tickAnchor, xTicks } from './OccupancyChart';
import { buildOccupancySeries, type OccupancyWorkerRow } from '@/lib/fleet-occupancy';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const H = 3_600_000;
const run = (runner: string, from: number, to: number): OccupancyWorkerRow => ({ runner, status: 'completed', startedAt: from, completedAt: to, updatedAt: null });

const render = (workers: OccupancyWorkerRow[], window: '24h' | '7d' | '30d' = '30d', capacityNow = 10, busyNow = 0) =>
  renderToStaticMarkup(<OccupancyPlot series={buildOccupancySeries({ window, now: NOW, workers })} capacityNow={capacityNow} busyNow={busyNow} />);

describe('OccupancyPlot', () => {
  it('a window with no work at all is one line, not a chart of zeros', () => {
    const html = render([]);
    expect(html).toContain('No agents ran in the past 30 days.');
    expect(html).not.toContain('<svg');
  });

  it('a peak of one on a ten-slot fleet is scaled to the data: the top gridline is 1, and capacity is not drawn', () => {
    const html = render([run('http://r', NOW - 5 * 24 * H, NOW - 5 * 24 * H + H)]);
    expect(html).toContain('>1</text>');
    expect(html).not.toContain('>10</text>');
    expect(html).not.toContain('occupancy-capacity-line');
    // Capacity is still stated, as a number.
    expect(html).toMatch(/Slots online<\/span><span[^>]*>10</);
  });

  it('draws slots online as a reference line when the data reaches that high', () => {
    const many = Array.from({ length: 4 }, () => run('http://r', NOW - 2 * H, NOW - H));
    expect(render(many, '24h', 4)).toContain('data-testid="occupancy-capacity-line"');
  });

  it('states peak, average, in use now and slots online as separate numbers', () => {
    const html = render([run('http://r', NOW - 2 * H, NOW - H)], '24h', 10, 3);
    for (const label of ['Peak', 'Average', 'In use now', 'Slots online']) expect(html).toContain(`>${label}<`);
    expect(html).toMatch(/In use now<\/span><span[^>]*>3</);
    expect(html).toMatch(/Average<\/span><span[^>]*>&lt;1</);
  });

  it('shows peak demand as its own line on 7d and 30d', () => {
    const w = [run('http://r', NOW - 3 * H, NOW - 2 * H)];
    expect(render(w, '30d')).toContain('occupancy-peak-line');
    expect(render(w, '7d')).toContain('occupancy-peak-line');
    expect(render(w, '24h')).not.toContain('occupancy-peak-line');
  });

  it('interactive sessions are their own chart with their own numbers, never a line on the runner axis', () => {
    const html = render([run('http://r', NOW - 3 * H, NOW - 2 * H), run('mcp', NOW - 3 * H, NOW - H)], '24h');
    expect(html).toContain('data-testid="occupancy-sessions"');
    expect(html).toContain('>Interactive sessions<');
    expect(html).not.toContain('own scale');
  });

  it('only sessions in the window: says there was no runner work, still shows the sessions', () => {
    const html = render([run('mcp', NOW - 3 * H, NOW - H)], '7d');
    expect(html).toContain('No runner work in the past 7 days.');
    expect(html).toContain('data-testid="occupancy-sessions"');
  });
});

describe('axis', () => {
  it('30d ticks are a week apart, ending on today', () => {
    const s = buildOccupancySeries({ window: '30d', now: NOW, workers: [] });
    const t = xTicks(s);
    expect(t[t.length - 1].i).toBe(29);
    expect(t[t.length - 1].i - t[t.length - 2].i).toBe(7);
  });

  it('edge labels anchor inward so they are not cut off', () => {
    expect(tickAnchor(5, 600)).toBe('start');
    expect(tickAnchor(300, 600)).toBe('middle');
    expect(tickAnchor(590, 600)).toBe('end');
  });
});

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

  it('an idle history still states the current capacity and busy count, in every window', () => {
    for (const w of ['24h', '7d', '30d'] as const) {
      const html = render([], w, 4, 0);
      expect(html).toContain('occupancy-empty');
      expect(html).toContain('occupancy-metrics');
      expect(html).toMatch(/>4<\/span><span[^>]*>Slots online</);
      expect(html).toMatch(/>0<\/span><span[^>]*>In use now</);
      expect(html).toContain('>Peak<');
      expect(html).toContain('>Average<');
      expect(html).not.toContain('<svg');
    }
  });

  it('a peak of one on a ten-slot fleet is scaled to the data: the top gridline is 1, and capacity is not drawn', () => {
    const html = render([run('http://r', NOW - 5 * 24 * H, NOW - 5 * 24 * H + H)]);
    expect(html).toContain('>1</text>');
    expect(html).not.toContain('>10</text>');
    expect(html).not.toContain('occupancy-capacity-line');
    // Capacity is still stated, as a number.
    expect(html).toMatch(/>10<\/span><span[^>]*>Slots online</);
  });

  it('draws slots online as a reference line when the data reaches that high', () => {
    const many = Array.from({ length: 4 }, () => run('http://r', NOW - 2 * H, NOW - H));
    expect(render(many, '24h', 4)).toContain('data-testid="occupancy-capacity-line"');
  });

  it('states peak, average, in use now and slots online as separate numbers', () => {
    const html = render([run('http://r', NOW - 2 * H, NOW - H)], '24h', 10, 3);
    for (const label of ['Peak', 'Average', 'In use now', 'Slots online']) expect(html).toContain(`>${label}<`);
    expect(html).toMatch(/>3<\/span><span[^>]*>In use now</);
    expect(html).toMatch(/>&lt;1<\/span><span[^>]*>Average</);
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

  it('splits runner average by owner with a separate Other / unattributed line', () => {
    const owned = (ownerId: string | null): OccupancyWorkerRow => ({ ...run('http://r', NOW - 3 * H, NOW - H), ownerId });
    const series = buildOccupancySeries({ window: '24h', now: NOW, workers: [owned('me'), owned('you'), owned(null)], viewerId: 'me' });
    const html = renderToStaticMarkup(<OccupancyPlot series={series} capacityNow={10} busyNow={0} />);
    expect(html).toContain('data-testid="occupancy-owner-split"');
    for (const label of ['Yours, average', 'Teammates, average', 'Other / unattributed, average']) expect(html).toContain(`>${label}<`);
  });

  it('states how many runner jobs lack an owner, and stays quiet when none do', () => {
    const job = (ownerId: string | null): OccupancyWorkerRow => ({ ...run('http://r', NOW - 3 * H, NOW - H), ownerId, runnerClass: 'personal' });
    const gappy = buildOccupancySeries({ window: '24h', now: NOW, workers: [job('me'), job(null)], viewerId: 'me' });
    expect(renderToStaticMarkup(<OccupancyPlot series={gappy} capacityNow={10} busyNow={0} />)).toContain('1 of 2 have no recorded owner');
    const whole = buildOccupancySeries({ window: '24h', now: NOW, workers: [job('me')], viewerId: 'me' });
    expect(renderToStaticMarkup(<OccupancyPlot series={whole} capacityNow={10} busyNow={0} />)).not.toContain('occupancy-coverage-note');
  });
});

describe('OccupancyPlot views', () => {
  it('defaults to Total, offering Mine and By member in one chart', () => {
    const html = render([run('http://r', NOW - 2 * H, NOW - H)], '24h');
    expect(html).toContain('data-testid="occupancy-view-picker"');
    for (const l of ['Total', 'Mine', 'By member']) expect(html).toContain(`>${l}<`);
    expect(html.match(/<svg/g)).toHaveLength(1);
    expect(html).toContain('data-testid="occupancy-owner-split"');
    expect(html).not.toContain('data-testid="occupancy-members"');
  });
});

import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { OccupancySparkline } from './OccupancySparkline';
import { buildOccupancySeries } from '@/lib/fleet-occupancy';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const H = 3_600_000;

const busy = buildOccupancySeries({
  window: '24h',
  now: NOW,
  workers: [
    { runner: 'http://r', status: 'completed', startedAt: NOW - 3 * H, completedAt: NOW - 2 * H, updatedAt: null },
    { runner: 'http://r', status: 'completed', startedAt: NOW - 3 * H, completedAt: NOW - 2.5 * H, updatedAt: null },
    { runner: 'mcp', status: 'running', startedAt: NOW - H, completedAt: null, updatedAt: null },
  ],
});

describe('OccupancySparkline', () => {
  const html = renderToStaticMarkup(<OccupancySparkline series={busy} href="/app/health/runners" />);

  it('says peak and average in words, an average under one as <1', () => {
    expect(html).toContain('Past 24h · Peak 2 · Avg &lt;1');
  });

  it('counts runner slots only: a session does not raise the peak', () => {
    expect(html).not.toContain('Peak 3');
    expect(html.toLowerCase()).not.toContain('session');
  });

  it('never states capacity or utilization; the tile does that in words', () => {
    expect(html.toLowerCase()).not.toContain('utiliz');
    expect(html).not.toContain('now');
    expect(html).not.toContain('%');
  });

  it('links to Runners & capacity', () => {
    expect(html).toContain('href="/app/health/runners"');
  });

  it('a day with no runner work says so and draws no line', () => {
    const idle = buildOccupancySeries({ window: '24h', now: NOW, workers: [] });
    const out = renderToStaticMarkup(<OccupancySparkline series={idle} />);
    expect(out).not.toContain('<svg');
    expect(out).toContain('No runner work in the past 24h');
  });

  describe('idle shade', () => {
    const shaded = (shade: { from: number; to: number }[], series = busy) =>
      renderToStaticMarkup(<OccupancySparkline series={series} shade={shade} />);

    it('never puts var() in an SVG paint attribute (Safari paints it black)', () => {
      const out = shaded([{ from: NOW - 10 * H, to: NOW - 8 * H }]);
      expect(out).not.toMatch(/\s(fill|stroke)="var\(/);
      expect(out).toMatch(/<rect[^>]*style="fill:var\(--q-tint\)"/);
      expect(out).not.toMatch(/<rect[^>]*fill="(#000|black)/);
    });

    it('draws the line after the shade so it stays on top', () => {
      const out = shaded([{ from: NOW - 10 * H, to: NOW - 8 * H }]);
      expect(out.indexOf('occupancy-shade')).toBeLessThan(out.indexOf('<path'));
      expect(out).toContain('stroke:var(--accent)');
    });

    it('a zero-length span still renders a 1-unit sliver', () => {
      const out = shaded([{ from: NOW - 5 * H, to: NOW - 5 * H }]);
      expect(out).toMatch(/occupancy-shade[^>]*width="1"/);
    });

    it('no shade renders no rect', () => {
      expect(shaded([])).not.toContain('occupancy-shade');
    });
  });
});

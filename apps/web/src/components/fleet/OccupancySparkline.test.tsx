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
});

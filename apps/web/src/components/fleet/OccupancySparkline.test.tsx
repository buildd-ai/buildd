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
  const html = renderToStaticMarkup(<OccupancySparkline series={busy} capacityNow={10} href="/app/health/runners" />);

  it('labels the ceiling as today\'s slot count, never as utilization', () => {
    expect(html).toContain('of 10 now');
    expect(html).toContain('data-testid="occupancy-ceiling"');
    expect(html.toLowerCase()).not.toContain('utiliz');
    expect(html).not.toContain('%');
  });

  it('gives peak and average for runner slots', () => {
    expect(html).toContain('peak 2');
    expect(html).toContain('avg 0.1');
  });

  it('draws sessions as their own line, not added to the slots', () => {
    expect(html).toContain('data-testid="occupancy-sessions-line"');
    expect(html).toContain('sessions peak 1');
  });

  it('links to Runners & capacity', () => {
    expect(html).toContain('href="/app/health/runners"');
  });

  it('an idle day with no sessions draws no sessions line and no ceiling without slots', () => {
    const idle = buildOccupancySeries({ window: '24h', now: NOW, workers: [] });
    const out = renderToStaticMarkup(<OccupancySparkline series={idle} capacityNow={0} />);
    expect(out).not.toContain('occupancy-sessions-line');
    expect(out).not.toContain('data-testid="occupancy-ceiling"');
    expect(out).toContain('peak 0');
  });
});

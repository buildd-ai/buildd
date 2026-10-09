import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatStrip, type StatStripProps } from './StatStrip';
import { buildOccupancySeries } from '@/lib/fleet-occupancy';

const base: StatStripProps = {
  live: 0,
  capacity: 4,
  runners: 1,
  needsYou: 0,
  needsYouDetail: null,
  mergedToday: 0,
  mergedDetail: null,
  prsInCi: [],
  selfHealed: 0,
  screensReviewed: null,
};

describe('StatStrip', () => {
  it('says "nothing merged", not a dash, when merged today has no detail', () => {
    const html = renderToStaticMarkup(<StatStrip {...base} />);
    expect(html).toContain('nothing merged');
    expect(html).not.toContain('—');
  });

  it('shows the merged detail when one is present', () => {
    const html = renderToStaticMarkup(<StatStrip {...base} mergedDetail="#451 #450" />);
    expect(html).toContain('#451 #450');
    expect(html).not.toContain('nothing merged');
  });

  it('shows the live count alone, never as live/capacity, and slots online in words', () => {
    const html = renderToStaticMarkup(<StatStrip {...base} live={1} />);
    expect(html).not.toContain('/4');
    expect(html).toContain('running now');
    expect(html).toContain('4 slots online');
  });

  it('with no runners online says so instead of 0/0', () => {
    const html = renderToStaticMarkup(<StatStrip {...base} capacity={0} />);
    expect(html).not.toContain('/0');
    expect(html).toContain('no runners online');
  });

  it('draws the 24h sparkline in Agents live when occupancy is given, linking to Runners & capacity', () => {
    const occupancy = buildOccupancySeries({ window: '24h', now: Date.UTC(2026, 9, 8, 12), workers: [] });
    const html = renderToStaticMarkup(<StatStrip {...base} occupancy={occupancy} />);
    expect(html).toContain('data-testid="occupancy-sparkline"');
    expect(html).toContain('href="/app/health/runners"');
  });

  it('draws no sparkline when occupancy did not load', () => {
    expect(renderToStaticMarkup(<StatStrip {...base} />)).not.toContain('occupancy-sparkline');
  });
});

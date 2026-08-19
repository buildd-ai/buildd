import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SparklineBar } from './SparklineBar';
import type { EffortDay } from './SparklineBar';

function makeDay(date: string, tokens: number, overrides?: Partial<EffortDay>): EffortDay {
  return { date, tokens, merged: 0, failed: 0, open: tokens > 0 ? 1 : 0, ...overrides };
}

const day = (date: string, tokens: number, merged = 0, failed = 0, open = 0): EffortDay => ({
  date, tokens, merged, failed, open,
});

const countRects = (html: string) => (html.match(/<rect/g) ?? []).length;

/** x coordinate of the first merged-segment rect, used to locate its slot. */
function successX(html: string): number {
  const tag = html.match(/<rect[^>]*fill="var\(--status-success\)"[^>]*>/);
  if (!tag) throw new Error('no merged-segment rect rendered');
  const x = tag[0].match(/x="([\d.]+)"/);
  if (!x) throw new Error('merged-segment rect has no x');
  return Number(x[1]);
}

describe('SparklineBar', () => {
  it('renders exactly 14 bar slots when given an empty days array', () => {
    const html = renderToStaticMarkup(<SparklineBar days={[]} />);
    // All 14 slots are null → each renders one zero-token rect with opacity="0.25"
    const matches = html.match(/opacity="0\.25"/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(14);
  });

  it('renders zero-token days with reduced opacity (0.25)', () => {
    const days: EffortDay[] = [makeDay('2026-07-15', 0)];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    expect(html).toContain('opacity="0.25"');
  });

  it('does NOT apply reduced opacity to days with tokens > 0', () => {
    const days: EffortDay[] = [makeDay('2026-07-15', 100)];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    // The non-zero day itself should not have opacity="0.25"
    // (The other 13 null slots will, but the active day's segments must not)
    // Parse out the active day: it is the last slot (slot 13, index 13)
    // Verify that a rect with fill="var(--accent)" and no opacity="0.25" exists
    expect(html).toContain('fill="var(--accent)"');
    // The active bar renders inside a <g> group; there should be exactly 13 zero-opacity rects
    const zeroes = html.match(/opacity="0\.25"/g);
    expect(zeroes).not.toBeNull();
    expect(zeroes!.length).toBe(13); // 13 null/empty slots, 1 active slot
  });

  it('normalises bars per-initiative: tallest bar fills full height', () => {
    const days: EffortDay[] = [
      makeDay('2026-07-14', 50),
      makeDay('2026-07-15', 100),
    ];
    const html = renderToStaticMarkup(<SparklineBar days={days} height={16} />);
    // The 100-token bar is the max → barH = Math.round(100/100 * 16) = 16
    // The 50-token bar → barH = Math.round(50/100 * 16) = 8
    expect(html).toContain('height="16"');
    expect(html).toContain('height="8"');
  });

  it('renders a 14-slot SVG even when fewer than 14 days are supplied', () => {
    // Supply 3 days → still 14 slots total (11 null + 3 active)
    const days: EffortDay[] = [
      makeDay('2026-07-13', 10),
      makeDay('2026-07-14', 20),
      makeDay('2026-07-15', 30),
    ];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    // 11 null slots → 11 reduced-opacity rects
    const zeroes = html.match(/opacity="0\.25"/g);
    expect(zeroes).not.toBeNull();
    expect(zeroes!.length).toBe(11);
  });

  it('renders an SVG with correct dimensions and aria-hidden', () => {
    const html = renderToStaticMarkup(<SparklineBar days={[]} width={48} height={16} />);
    expect(html).toContain('width="48"');
    expect(html).toContain('height="16"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('applies className to the SVG element', () => {
    const html = renderToStaticMarkup(<SparklineBar days={[]} className="test-cls" />);
    expect(html).toContain('class="test-cls"');
  });

  it('accepts custom width and height props and sets viewBox', () => {
    const html = renderToStaticMarkup(<SparklineBar days={[]} width={96} height={24} />);
    expect(html).toContain('width="96"');
    expect(html).toContain('height="24"');
    expect(html).toContain('viewBox="0 0 96 24"');
  });

  it('renders segmented bars for days with merged + failed + open data', () => {
    const days = [day('2025-01-14', 1000, 5, 2, 3)];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    // 13 placeholder slots + 3 rects for the active day
    expect(countRects(html)).toBeGreaterThan(14);
    expect(html).toContain('var(--status-success)');
    expect(html).toContain('var(--status-error)');
    expect(html).toContain('var(--accent)');
  });

  it('only renders merged and open segments when failed=0', () => {
    const days = [day('2025-01-14', 500, 3, 0, 7)];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    expect(html).toContain('var(--status-success)');
    expect(html).not.toContain('var(--status-error)');
    expect(html).toContain('var(--accent)');
  });

  it('renders a single open segment when merged=0 and failed=0', () => {
    const days = [day('2025-01-14', 800, 0, 0, 10)];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    expect(html).not.toContain('var(--status-success)');
    expect(html).not.toContain('var(--status-error)');
    expect(html).toContain('var(--accent)');
  });

  it('falls back to open color when all segment counts are zero but tokens > 0', () => {
    const days = [day('2025-01-14', 500, 0, 0, 0)];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    expect(html).toContain('var(--accent)');
  });

  it('fills gaps in the 14-day window with placeholder bars', () => {
    const days = [
      day('2025-01-01', 100, 1, 0, 0),
      day('2025-01-14', 200, 2, 1, 1),
    ];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    // 12 gap slots + rects for the 2 populated days
    expect(countRects(html)).toBeGreaterThan(14);
    const opacityCount = (html.match(/opacity="0\.25"/g) ?? []).length;
    expect(opacityCount).toBe(12);
  });

  // Spec §6.4: a renderer MUST NOT align its slots to the latest date present.
  // Aligning drew a six-day-old burst at the right-hand edge, so an initiative
  // that had been silent all week read as busy.
  it('places a day at its position in the window, not at the edge nearest its date', () => {
    const dense: EffortDay[] = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-08-${String(i + 3).padStart(2, '0')}`,
      tokens: i === 7 ? 900 : 0,
      merged: i === 7 ? 3 : 0,
      failed: 0,
      open: 0,
    }));

    const width = 84;
    const html = renderToStaticMarkup(<SparklineBar days={dense} width={width} height={24} />);

    const barW = Math.max(2, (width - 13) / 14);
    const slotOf = (x: number) => Math.round(x / (barW + 1));

    expect(slotOf(successX(html))).toBe(7);
    // Not parked at the right-hand edge, which is where the old code drew it.
    expect(slotOf(successX(html))).not.toBe(13);
  });

  it('keeps the newest entry at the right edge when given fewer than 14 days', () => {
    // Short input pads on the left: a caller supplying 3 days under-claims
    // history rather than shifting it sideways.
    const days = [day('2026-08-14', 100, 0, 1, 0), day('2026-08-15', 100), day('2026-08-16', 100, 2, 0, 0)];
    const html = renderToStaticMarkup(<SparklineBar days={days} width={84} height={24} />);

    const barW = Math.max(2, (84 - 13) / 14);
    expect(Math.round(successX(html) / (barW + 1))).toBe(13);
  });

  it('sorts days by date so oldest renders left (earliest index) and newest renders right', () => {
    const days = [
      day('2025-01-14', 500, 5, 0, 0),  // newest: only merged → success color
      day('2025-01-01', 500, 0, 5, 0),  // oldest: only failed → error color
    ];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    const successIdx = html.indexOf('var(--status-success)');
    const errorIdx = html.indexOf('var(--status-error)');
    // oldest (error) should appear before newest (success) in SVG output (left → right)
    expect(errorIdx).toBeLessThan(successIdx);
  });
});

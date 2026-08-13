import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SparklineBar } from './SparklineBar';
import type { EffortDay } from './SparklineBar';

function makeDay(date: string, tokens: number, overrides?: Partial<EffortDay>): EffortDay {
  return { date, tokens, merged: 0, failed: 0, open: tokens > 0 ? 1 : 0, ...overrides };
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
});

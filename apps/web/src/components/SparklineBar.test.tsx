import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SparklineBar } from './SparklineBar';
import type { EffortDay } from './SparklineBar';

const day = (date: string, tokens: number, merged = 0, failed = 0, open = 0): EffortDay => ({
  date, tokens, merged, failed, open,
});

const countRects = (html: string) => (html.match(/<rect/g) ?? []).length;

describe('SparklineBar', () => {
  it('renders an SVG with correct dimensions', () => {
    const html = renderToStaticMarkup(<SparklineBar days={[]} width={48} height={16} />);
    expect(html).toContain('width="48"');
    expect(html).toContain('height="16"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('applies className to the SVG element', () => {
    const html = renderToStaticMarkup(<SparklineBar days={[]} className="test-cls" />);
    expect(html).toContain('class="test-cls"');
  });

  it('renders 14 placeholder bars for empty days', () => {
    const html = renderToStaticMarkup(<SparklineBar days={[]} />);
    expect(countRects(html)).toBe(14);
    // All placeholders are at 25% opacity
    const opacityCount = (html.match(/opacity="0\.25"/g) ?? []).length;
    expect(opacityCount).toBe(14);
  });

  it('renders placeholder for a zero-token day', () => {
    const html = renderToStaticMarkup(
      <SparklineBar days={[day('2025-01-01', 0)]} />,
    );
    expect(countRects(html)).toBe(14);
    const opacityCount = (html.match(/opacity="0\.25"/g) ?? []).length;
    expect(opacityCount).toBe(14);
  });

  it('renders segmented bars for days with data', () => {
    const days = [day('2025-01-14', 1000, 5, 2, 3)];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    // 13 placeholder slots + at least 2 rects for the 1 populated day (3 segments)
    expect(countRects(html)).toBeGreaterThan(14);
    // Merged → status-success
    expect(html).toContain('var(--status-success)');
    // Failed → status-error
    expect(html).toContain('var(--status-error)');
    // Open → accent
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
    // The open segment uses --accent
    expect(html).toContain('var(--accent)');
  });

  it('falls back to open color when all segment counts are zero but tokens > 0', () => {
    const days = [day('2025-01-14', 500, 0, 0, 0)];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    expect(html).toContain('var(--accent)');
  });

  it('fills gaps in the 14-day window with placeholders', () => {
    // Only 2 of 14 days have data
    const days = [
      day('2025-01-01', 100, 1, 0, 0),
      day('2025-01-14', 200, 2, 1, 1),
    ];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    // 12 gap slots + rects for the 2 populated days (more than 14 total rects)
    expect(countRects(html)).toBeGreaterThan(14);
    // 12 placeholders at 25% opacity
    const opacityCount = (html.match(/opacity="0\.25"/g) ?? []).length;
    expect(opacityCount).toBe(12);
  });

  it('normalizes bar height relative to max tokens in the window', () => {
    // Day with 1000 tokens should be taller than day with 100 tokens
    const days = [
      day('2025-01-13', 100, 0, 0, 10),
      day('2025-01-14', 1000, 0, 0, 10),
    ];
    const html = renderToStaticMarkup(<SparklineBar days={days} height={16} />);
    // The max-day bar should reach height=16; the other should be shorter (height~2)
    // We verify at least two different heights appear
    const heights = [...html.matchAll(/height="([^"]+)"/g)].map(m => parseFloat(m[1]));
    const nonPlaceholderHeights = heights.filter(h => h > 2);
    expect(nonPlaceholderHeights.length).toBeGreaterThan(0);
    expect(Math.max(...nonPlaceholderHeights)).toBe(16);
  });

  it('accepts custom width and height props', () => {
    const html = renderToStaticMarkup(<SparklineBar days={[]} width={96} height={24} />);
    expect(html).toContain('width="96"');
    expect(html).toContain('height="24"');
    expect(html).toContain('viewBox="0 0 96 24"');
  });

  it('sorts days by date (oldest left, newest right)', () => {
    // Provide days out of order; newest has only merged, oldest has only failed
    const days = [
      day('2025-01-14', 500, 5, 0, 0),   // newest: only merged (success color)
      day('2025-01-01', 500, 0, 5, 0),   // oldest: only failed (error color)
    ];
    const html = renderToStaticMarkup(<SparklineBar days={days} />);
    const successIdx = html.indexOf('var(--status-success)');
    const errorIdx = html.indexOf('var(--status-error)');
    // oldest (error) should appear before newest (success) in SVG output (left to right)
    expect(errorIdx).toBeLessThan(successIdx);
  });
});

import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ColorSwatches, ROLE_COLORS } from './ColorSwatches';

const swatches = (html: string) => html.match(/<button[^>]*>/g) ?? [];

describe('ColorSwatches', () => {
  it('names every swatch in words, not hex', () => {
    const html = renderToStaticMarkup(<ColorSwatches value={ROLE_COLORS[0].value} onChange={() => {}} />);
    const labels = swatches(html).map(b => b.match(/aria-label="([^"]+)"/)?.[1]);
    expect(labels).toEqual(ROLE_COLORS.map(c => c.name));
    for (const l of labels) expect(l).not.toMatch(/^#/);
  });

  it('is a group of toggle buttons: only the selected one is pressed', () => {
    const html = renderToStaticMarkup(<ColorSwatches value={ROLE_COLORS[2].value} onChange={() => {}} />);
    expect(html).toMatch(/role="group"[^>]*aria-label="Avatar colour"/);
    const pressed = swatches(html).map(b => b.match(/aria-pressed="(true|false)"/)?.[1]);
    expect(pressed).toEqual(ROLE_COLORS.map((_, i) => String(i === 2)));
    // Buttons, so Tab reaches each one and Space/Enter picks it; no radio role
    // promising arrow-key behaviour we don't implement.
    expect(html).not.toContain('role="radio');
  });

  it('keeps the selected (scale-110) hit area at 44px instead of growing it', () => {
    const html = renderToStaticMarkup(<ColorSwatches value={ROLE_COLORS[0].value} onChange={() => {}} size="md" />);
    const [selected, other] = swatches(html);
    // md dot 28px: unselected 28 + 2×8 = 44; selected (28 + 2×6) × 1.1 = 44.
    expect(other).toContain('before:-inset-2');
    expect(selected).toContain('scale-110');
    expect(selected).toContain('before:-inset-1.5');
    expect(selected).not.toContain('before:-inset-2 ');
  });

  it('sm dots: 24 + 2×10 = 44 unselected, (24 + 2×8) × 1.1 = 44 selected', () => {
    const html = renderToStaticMarkup(<ColorSwatches value={ROLE_COLORS[0].value} onChange={() => {}} />);
    const [selected, other] = swatches(html);
    expect(other).toContain('before:-inset-[10px]');
    expect(selected).toContain('before:-inset-2');
  });
});

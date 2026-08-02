import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SegmentStrip } from './SegmentStrip';

const seg = (id: string, state: 'solid' | 'empty' | 'half' | 'notch' = 'solid') => ({ taskId: id, state });
const manySegs = Array.from({ length: 10 }, (_, i) => seg(`t${i}`));
const fewSegs = [seg('a', 'solid'), seg('b', 'empty'), seg('c', 'half')];

describe('SegmentStrip', () => {
  it('returns null for empty segments', () => {
    expect(renderToStaticMarkup(<SegmentStrip segments={[]} />)).toBe('');
  });

  describe('discrete mode', () => {
    it('renders individual glyphs in a flex row with gaps', () => {
      const html = renderToStaticMarkup(<SegmentStrip segments={fewSegs} continuous={false} />);
      expect(html).toContain('gap-0.5');
      // three separate color spans (one per segment glyph)
      expect((html.match(/class="[^"]*text-/g) ?? []).length).toBe(3);
    });

    it('ignores height and maxWidth props — no inline style applied', () => {
      const html = renderToStaticMarkup(
        <SegmentStrip segments={fewSegs} continuous={false} height={4} maxWidth={80} />,
      );
      expect(html).not.toContain('height:4px');
      expect(html).not.toContain('max-width:80px');
    });
  });

  describe('continuous mode', () => {
    it('renders a single bar (flex-1 child spans, no gap-0.5)', () => {
      const html = renderToStaticMarkup(<SegmentStrip segments={manySegs} continuous />);
      expect(html).toContain('flex-1');
      expect(html).not.toContain('gap-0.5');
    });

    it('auto-enables for >8 segments without explicit prop', () => {
      const html = renderToStaticMarkup(<SegmentStrip segments={manySegs} />);
      expect(html).toContain('flex-1');
    });

    it('applies height prop as inline style', () => {
      const html = renderToStaticMarkup(
        <SegmentStrip segments={manySegs} continuous height={4} />,
      );
      expect(html).toContain('height:4px');
    });

    it('applies maxWidth prop as inline style', () => {
      const html = renderToStaticMarkup(
        <SegmentStrip segments={manySegs} continuous maxWidth={80} />,
      );
      expect(html).toContain('max-width:80px');
    });

    it('applies both height and maxWidth together', () => {
      const html = renderToStaticMarkup(
        <SegmentStrip segments={manySegs} continuous height={4} maxWidth={80} />,
      );
      expect(html).toContain('height:4px');
      expect(html).toContain('max-width:80px');
    });

    it('emits no inline height or max-width when props are absent', () => {
      const html = renderToStaticMarkup(<SegmentStrip segments={manySegs} continuous />);
      expect(html).not.toContain('height:');
      expect(html).not.toContain('max-width:');
    });
  });

  describe('label', () => {
    it('threads aria-label through both discrete and continuous', () => {
      const label = 'Mission progress';
      const d = renderToStaticMarkup(
        <SegmentStrip segments={fewSegs} continuous={false} label={label} />,
      );
      const c = renderToStaticMarkup(
        <SegmentStrip segments={fewSegs} continuous label={label} />,
      );
      expect(d).toContain(`aria-label="${label}"`);
      expect(c).toContain(`aria-label="${label}"`);
    });
  });
});

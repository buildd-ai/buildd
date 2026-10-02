import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Chip, { type ChipTone, type ChipVariant } from './Chip';

const classesOf = (html: string) => html.match(/^<span class="([^"]*)"/)?.[1].split(/\s+/) ?? [];

describe('Chip', () => {
  it('is a square, uppercase, mono chip on the chip type role that never wraps', () => {
    const cls = classesOf(renderToStaticMarkup(<Chip tone="success">Done</Chip>));
    for (const c of ['text-chip', 'uppercase', 'font-mono', 'border', 'whitespace-nowrap', 'shrink-0']) {
      expect(cls).toContain(c);
    }
    expect(cls.some(c => c.startsWith('rounded'))).toBe(false);
  });

  it('draws a leading square dot by default and drops it with dot={false}', () => {
    expect(renderToStaticMarkup(<Chip tone="error">Failed</Chip>)).toContain('bg-current');
    expect(renderToStaticMarkup(<Chip tone="error" dot={false}>Failed</Chip>)).not.toContain('bg-current');
  });

  it('pulses the dot only for live states', () => {
    expect(renderToStaticMarkup(<Chip tone="running" pulse>Running</Chip>)).toContain('animate-status-pulse');
    expect(renderToStaticMarkup(<Chip tone="running">Running</Chip>)).not.toContain('animate-status-pulse');
  });

  it('renders a muted trailing suffix after the label', () => {
    const html = renderToStaticMarkup(<Chip tone="muted" trailing="3m">Checked</Chip>);
    expect(html).toMatch(/Checked<span class="opacity-60">3m<\/span>/);
  });

  it('passes data-testid through and records its tone', () => {
    const html = renderToStaticMarkup(<Chip tone="accent" data-testid="x">Yours</Chip>);
    expect(html).toContain('data-testid="x"');
    expect(html).toContain('data-tone="accent"');
  });

  it('uses tokens only for every tone and variant (no raw hex, no arbitrary text size)', () => {
    const tones: ChipTone[] = ['success', 'running', 'warning', 'error', 'info', 'accent', 'muted'];
    const variants: ChipVariant[] = ['outline', 'soft', 'solid'];
    for (const tone of tones) {
      for (const variant of variants) {
        const html = renderToStaticMarkup(<Chip tone={tone} variant={variant}>x</Chip>);
        expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(html).not.toMatch(/text-\[\d/);
      }
    }
  });
});

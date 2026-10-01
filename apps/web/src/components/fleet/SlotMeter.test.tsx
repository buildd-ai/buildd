import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlotMeter } from './SlotMeter';

const squares = (html: string) => html.split('<i ').length - 1;
const filled = (html: string) => html.split('bg-accent').length - 1;

describe('SlotMeter', () => {
  it('draws one square per slot under the cap', () => {
    const html = renderToStaticMarkup(<SlotMeter live={1} max={4} />);
    expect(squares(html)).toBe(4);
    expect(filled(html)).toBe(1);
  });

  it('bounds the squares for capacity above the default cap', () => {
    expect(squares(renderToStaticMarkup(<SlotMeter live={0} max={64} />))).toBe(16);
  });

  it('honours a tighter maxSquares cap with zero use', () => {
    const html = renderToStaticMarkup(<SlotMeter live={0} max={64} maxSquares={8} />);
    expect(squares(html)).toBe(8);
    expect(filled(html)).toBe(0);
  });

  it('keeps idle squares quieter than the strong border used for active work', () => {
    const html = renderToStaticMarkup(<SlotMeter live={0} max={3} />);
    expect(html).not.toContain('border-border-strong');
  });

  it('fills every drawn square when live exceeds the cap', () => {
    const html = renderToStaticMarkup(<SlotMeter live={30} max={64} maxSquares={8} />);
    expect(filled(html)).toBe(8);
  });
});

describe('missions header slots chip', () => {
  const src = readFileSync(join(import.meta.dir, '../../app/app/(protected)/missions/page.tsx'), 'utf8');
  const chip = src.slice(src.indexOf('data-testid="missions-slots"'), src.indexOf('<SetUpChatNudge'));

  it('never wraps the live/capacity label', () => {
    expect(chip).toContain('whitespace-nowrap');
    expect(chip).toContain('shrink-0');
  });

  it('bounds the meter for phones', () => {
    expect(chip).toMatch(/maxSquares=\{\d+\}/);
  });
});

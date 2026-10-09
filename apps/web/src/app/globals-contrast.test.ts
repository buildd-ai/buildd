/**
 * WCAG contrast for the tokens in globals.css (docs/design/design-system.md §2).
 *
 * Every text token reaches AA (4.5:1) on every surface it can sit on, in both
 * themes, with no elevation exemption. Each state hue also reaches AA on its
 * own tint (a chip or cell fill), and no text token is lighter than
 * `--text-muted` (the prototype's `--sub`, the floor for text). `--faint` is
 * graphics only (strip outlines, idle marks) and needs 3:1, the non-text floor.
 *
 * Translucent tokens (night tints) are composited over the card before
 * measuring, since that is where a chip sits.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, 'globals.css'), 'utf8');

type Rgba = [number, number, number, number];

function themeBlock(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`theme block not found: ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  const tokens: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|rgba\([^)]*\))\s*;/g)) {
    tokens[m[1]] = m[2].toLowerCase();
  }
  return tokens;
}

export function parse(colour: string): Rgba {
  if (colour.startsWith('#')) {
    const n = parseInt(colour.slice(1), 16);
    return [n >> 16, (n >> 8) & 0xff, n & 0xff, 1];
  }
  const [r, g, b, a] = colour.match(/[\d.]+/g)!.map(Number);
  return [r, g, b, a ?? 1];
}

/** `fg` laid over an opaque `bg`. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const [R, G, B] = [r, g, b].map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = {
  dark: themeBlock(':root, [data-theme="dark"]'),
  light: themeBlock('[data-theme="light"]'),
};

const TEXT_TOKENS = [
  'text-primary', 'text-secondary', 'text-desc', 'text-muted', 'accent-text', 'q',
  'status-success', 'status-running', 'status-warning', 'status-error', 'status-info',
];
const SURFACES = ['surface-1', 'surface-2', 'surface-3', 'surface-4', 'card', 'card-hover', 'inset'];
/** Each state hue on the tint drawn behind it. */
const ON_TINT: Array<[string, string]> = [
  ['status-success', 'ok-tint'],
  ['status-info', 'run-tint'],
  ['accent-text', 'accent-soft'],
  ['status-error', 'bad-tint'],
  ['q', 'q-tint'],
  ['text-muted', 'q-tint'],
];
const AA = 4.5;
const GRAPHICS = 3;

describe('globals.css contrast', () => {
  it('computes WCAG ratios correctly', () => {
    expect(contrast(parse('#000000'), parse('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrast(parse('#777777'), parse('#ffffff'))).toBeCloseTo(4.48, 2);
    expect(over(parse('rgba(255, 255, 255, 0.5)'), parse('#000000'))).toEqual([127.5, 127.5, 127.5, 1]);
  });

  for (const [theme, tokens] of Object.entries(THEMES)) {
    describe(theme, () => {
      const colour = (t: string): Rgba => {
        expect(tokens[t]).toBeDefined();
        const c = parse(tokens[t]);
        return c[3] < 1 ? over(c, parse(tokens.card)) : c;
      };

      for (const fg of TEXT_TOKENS) {
        for (const bg of SURFACES) {
          it(`--${fg} on --${bg} >= ${AA}:1`, () => {
            expect(contrast(colour(fg), colour(bg))).toBeGreaterThanOrEqual(AA);
          });
        }
      }

      for (const [fg, tint] of ON_TINT) {
        it(`--${fg} on --${tint} >= ${AA}:1`, () => {
          expect(contrast(colour(fg), colour(tint))).toBeGreaterThanOrEqual(AA);
        });
      }

      it(`--on-ink on --text-primary (the charcoal button) >= ${AA}:1`, () => {
        expect(contrast(colour('on-ink'), colour('text-primary'))).toBeGreaterThanOrEqual(AA);
      });

      it(`--on-accent on --accent >= ${AA}:1`, () => {
        expect(contrast(colour('on-accent'), colour('accent'))).toBeGreaterThanOrEqual(AA);
      });

      for (const bg of ['surface-1', 'card', 'inset']) {
        it(`--faint (graphics only) on --${bg} >= ${GRAPHICS}:1`, () => {
          expect(contrast(colour('faint'), colour(bg))).toBeGreaterThanOrEqual(GRAPHICS);
        });
      }

      it('no text token is lighter than --text-muted (the text floor)', () => {
        for (const bg of SURFACES) {
          const floor = contrast(colour('text-muted'), colour(bg));
          for (const fg of ['text-primary', 'text-secondary', 'text-desc']) {
            expect(contrast(colour(fg), colour(bg))).toBeGreaterThanOrEqual(floor);
          }
        }
      });

      it('--faint is quieter than every text token, so it never passes for text', () => {
        const bg = colour('card');
        for (const fg of TEXT_TOKENS) {
          expect(contrast(colour(fg), bg)).toBeGreaterThan(contrast(colour('faint'), bg));
        }
      });
    });
  }
});

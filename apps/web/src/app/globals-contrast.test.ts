/**
 * WCAG contrast floor for the text tokens in globals.css.
 *
 * Every text token must reach AA (4.5:1) against the surfaces text normally
 * sits on, in both themes. Exemptions are listed explicitly below — adding one
 * is a design decision, not a way to make this test pass.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, 'globals.css'), 'utf8');

function themeBlock(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`theme block not found: ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  const tokens: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[m[1]] = m[2].toLowerCase();
  }
  return tokens;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 0xff, n & 0xff].map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = {
  dark: themeBlock(':root, [data-theme="dark"]'),
  light: themeBlock('[data-theme="light"]'),
};

const TEXT_TOKENS = ['text-primary', 'text-secondary', 'text-desc', 'text-muted'];
const SURFACES = ['surface-1', 'surface-2', 'card'];
const AA = 4.5;

/** Documented exemptions: surface-4 is tooltip/highest-elevation, where muted/desc only need large-text AA. */
const EXEMPT_SURFACE = 'surface-4';
const EXEMPT_FLOOR = 3;

describe('globals.css contrast', () => {
  it('computes WCAG ratios correctly', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  for (const [theme, tokens] of Object.entries(THEMES)) {
    describe(theme, () => {
      for (const fg of TEXT_TOKENS) {
        for (const bg of SURFACES) {
          it(`--${fg} on --${bg} >= ${AA}:1`, () => {
            expect(tokens[fg]).toBeDefined();
            expect(tokens[bg]).toBeDefined();
            expect(contrast(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(AA);
          });
        }
        it(`--${fg} on --${EXEMPT_SURFACE} >= ${EXEMPT_FLOOR}:1 (exemption)`, () => {
          expect(contrast(tokens[fg], tokens[EXEMPT_SURFACE])).toBeGreaterThanOrEqual(EXEMPT_FLOOR);
        });
      }

      for (const bg of ['surface-1', 'card']) {
        it(`--accent-text on --${bg} >= ${AA}:1`, () => {
          expect(contrast(tokens['accent-text'], tokens[bg])).toBeGreaterThanOrEqual(AA);
        });
      }

      it('keeps the hierarchy: secondary > desc > muted', () => {
        const bg = tokens['surface-1'];
        const r = (t: string) => contrast(tokens[t], bg);
        expect(r('text-secondary')).toBeGreaterThan(r('text-desc'));
        expect(r('text-desc')).toBeGreaterThan(r('text-muted'));
      });
    });
  }
});

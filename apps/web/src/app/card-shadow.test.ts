/**
 * The hard offset shadow under a .card must read as depth, not as a second
 * border. In dark mode a light offset (it was a pale cream) sat beside the
 * pale card outline and looked like a doubled edge. The shadow colour has to
 * be darker than the page it falls on, in both themes.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, 'globals.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`theme block not found: ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

/** Luminance-ish of a token's colour: #rrggbb, or rgba() composited over `under`. */
function colourLum(body: string, token: string, under?: number): number {
  const m = body.match(new RegExp(`--${token}:\\s*([^;]+);`));
  if (!m) throw new Error(`--${token} not found`);
  const h = m[1].match(/#([0-9a-fA-F]{6})/);
  if (h) {
    const n = parseInt(h[1], 16);
    return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff);
  }
  const r = m[1].match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/);
  if (!r) throw new Error(`--${token} has no parseable colour: ${m[1]}`);
  const [R, G, B, A] = [Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])];
  const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  return under === undefined ? l : l * A + under * (1 - A);
}

describe('--card-shadow', () => {
  for (const [theme, selector] of [['dark', ':root, [data-theme="dark"]'], ['light', '[data-theme="light"]']] as const) {
    it(`${theme}: is a hard offset darker than the page`, () => {
      const body = block(selector);
      const shadow = body.match(/--card-shadow:\s*([^;]+);/)![1];
      expect(shadow).toMatch(/^5px 5px 0 0 /);
      const page = colourLum(body, 'surface-1');
      expect(colourLum(body, 'card-shadow', page)).toBeLessThan(page);
    });
  }
});

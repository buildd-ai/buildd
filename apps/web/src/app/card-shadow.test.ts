/**
 * No shadows: a frame is a 1px hairline (1.5px for a focused card or a
 * decision), never a hard offset (docs/design/design-system.md §2.6). The
 * shadow tokens resolve to none in both themes, and so does every step of the
 * Tailwind shadow scale, so `shadow`, `shadow-md` and `shadow-[var(--card-shadow)]`
 * draw nothing.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../../tailwind.config';

const css = readFileSync(join(import.meta.dir, 'globals.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`theme block not found: ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('no shadows', () => {
  for (const [theme, selector] of [['dark', ':root, [data-theme="dark"]'], ['light', '[data-theme="light"]']] as const) {
    for (const token of ['card-shadow', 'accent-shadow']) {
      it(`${theme}: --${token} is none`, () => {
        expect(block(selector)).toMatch(new RegExp(`--${token}:\\s*none;`));
      });
    }
  }

  it('every step of the Tailwind shadow scale is none', () => {
    const scale = (config.theme?.extend?.boxShadow ?? {}) as Record<string, string>;
    expect(Object.keys(scale)).toContain('DEFAULT');
    for (const v of Object.values(scale)) expect(v).toBe('none');
  });

  it('.card is framed by a 1px hairline on the card radius', () => {
    const card = css.match(/\n {2}\.card \{([^}]*)\}/)![1];
    expect(card).toContain('border: 1px solid var(--border);');
    expect(card).toContain('border-radius: var(--radius-card);');
  });
});

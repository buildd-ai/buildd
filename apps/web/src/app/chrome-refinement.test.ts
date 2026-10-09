/**
 * Shared chrome in the refined language (docs/design/design-system.md §1.1):
 * all-caps tracked labels are for nothing but display type now, and a
 * segmented control is a quiet trough, not a framed orange switch. These
 * classes reach every page, so a regression here undoes the pass everywhere.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(import.meta.dir, 'globals.css'), 'utf8');

function block(selector: string): string {
  const re = new RegExp(`^\\s*${selector.replace(/[.\\-]/g, m => `\\${m}`)}\\s*\\{([^}]*)\\}`, 'm');
  const m = CSS.match(re);
  if (!m) throw new Error(`no ${selector} block in globals.css`);
  return m[1];
}

describe('shared chrome', () => {
  for (const sel of ['.section-label', '.section-label-missions', '.status-pill', '.health-pill', '.field-label', '.type-label']) {
    it(`${sel} is set in the case it was written, without tracking`, () => {
      const b = block(sel);
      expect(b).not.toMatch(/text-transform:\s*uppercase/);
      expect(b).not.toMatch(/letter-spacing/);
    });
  }

  it('.seg is a tinted trough with no frame', () => {
    const b = block('.seg');
    expect(b).toContain('var(--q-tint)');
    expect(b).not.toMatch(/border:\s*1px/);
  });

  it('the chosen segment is lifted onto the card in ink, not filled orange', () => {
    const b = block('.seg-item-active');
    expect(b).toContain('var(--card)');
    expect(b).toContain('var(--text-primary)');
    expect(b).not.toContain('var(--accent)');
  });

  it('segments have no hairline dividers between them', () => {
    expect(CSS).not.toMatch(/\.seg-item \+ \.seg-item\s*\{/);
  });
});

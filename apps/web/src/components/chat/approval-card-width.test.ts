import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Container queries are not computed by happy-dom, so this pins the stylesheet:
// the card's two-column rows key off the card's own width, never the window's.
const GLOBALS = readFileSync(join(import.meta.dir, '..', '..', 'app', 'globals.css'), 'utf8');

function blockAfter(open: string): string {
  const start = GLOBALS.indexOf(open);
  if (start < 0) return '';
  let depth = 0;
  for (let i = GLOBALS.indexOf('{', start); i < GLOBALS.length; i++) {
    if (GLOBALS[i] === '{') depth++;
    if (GLOBALS[i] === '}' && --depth === 0) return GLOBALS.slice(start, i + 1);
  }
  return '';
}

describe('approval card responds to its own width', () => {
  const wide = blockAfter('@container approval-card (min-width: 420px)');

  it('the wrapper is an inline-size container', () => {
    expect(GLOBALS).toMatch(/\[data-testid="approval-card"\] \{ container: approval-card \/ inline-size; \}/);
  });

  it('two columns, desktop padding and title size only apply in a wide container', () => {
    expect(wide).toContain('grid-template-columns: 110px minmax(0, 1fr)');
    expect(wide).toContain('padding: 0 20px 16px');
    expect(wide).toContain('font-size: 20px');
  });

  it('no viewport media query decides the card layout', () => {
    expect(blockAfter('@media (min-width: 768px) {\n    .kit-card.buildd-approval')).toBe('');
    const outside = GLOBALS.replace(wide, '');
    expect(outside).not.toMatch(/\.buildd-approval \.kit-change \{ grid-template-columns/);
  });

  it('narrow base keeps the stacked rows and the 320px single-column card', () => {
    expect(GLOBALS).toContain('.buildd-approval .kit-change { gap: 2px 16px; padding: 8px 0;');
    const kit = readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', 'packages/ai-kit/src/chat/styles.css'), 'utf8');
    expect(kit).toMatch(/\.kit-card \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(kit).toMatch(/\.kit-change \{ display: grid; gap: 2px;/);
  });
});

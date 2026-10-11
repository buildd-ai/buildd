import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// The question card is rendered in panes of any width (task page, mission
// drawer, chat feed). Its layout must follow the pane, not the viewport, or a
// narrow drawer on a wide screen gets desktop type and a 3-up option grid.
const src = readFileSync(join(__dirname, 'QuestionHero.tsx'), 'utf8');

describe('QuestionHero layout follows its container', () => {
  it('is wrapped in a container-query root', () => {
    expect(src).toContain('className="@container min-w-0"');
  });
  it('uses no viewport md:/xl: layout variants', () => {
    expect(/(^|[\s'"`])(md|xl):/.test(src.replace(/scroll-mt-16 md:scroll-mt-4/, ''))).toBe(false);
  });
  it('option columns are minmax(0,1fr) so long words cannot squeeze text', () => {
    expect(src).toContain('grid-cols-[minmax(0,1fr)]');
    expect(src).not.toMatch(/grid-cols-[23]\b/);
  });
});

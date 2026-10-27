import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Navigation R-21: Home holds the reading measure (--content-measure, <=840px)
// like the mission and task pages; no 1320px column.
const read = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8');

describe('Home column (R-21)', () => {
  for (const file of ['page.tsx', 'HomeLive.tsx']) {
    it(`${file} uses PageColumn and no 1320px class`, () => {
      const src = read(file);
      expect(src).toContain("from '@/components/ui/PageColumn'");
      expect(src).toContain('<PageColumn>');
      expect(src).not.toContain('1320');
    });
  }

  it('the measure token is at most 840px', () => {
    const css = readFileSync(join(import.meta.dir, '../../../globals.css'), 'utf8');
    expect(Number(/--content-measure:\s*(\d+)px/.exec(css)![1])).toBeLessThanOrEqual(840);
  });
});

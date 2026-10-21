/**
 * `.animate-status-pulse` is an unlayered rule in globals.css, so it beats
 * Tailwind's layered `motion-reduce:animate-none`: a call site cannot stop the
 * pulse on its own. The stylesheet has to (task 7b83507d; the live marks on the
 * task page kept pulsing under reduced motion).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, 'globals.css'), 'utf8');

describe('reduced motion', () => {
  it('stops the status pulse', () => {
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map(m => m[1]);
    expect(blocks.some(b => /\.animate-status-pulse \{\s*animation: none;/.test(b))).toBe(true);
  });
});

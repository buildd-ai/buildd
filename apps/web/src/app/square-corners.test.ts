/**
 * Square corners: the brand radius is 0 (.claude/skills/ui_designer, "Square
 * Everything"). tailwind.config.ts zeroes the whole `rounded-*` scale, so
 * `rounded`, `rounded-lg` and `rounded-full` all render square. An arbitrary
 * value (`rounded-[10px]`, `rounded-r-[10px]`) bypasses that scale and draws a
 * real curve, which is how the Home "In flight" and action cards came out
 * rounded against square neighbours.
 *
 * No `rounded*-[...]` token may appear in app source.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';

const SRC = join(import.meta.dir, '..');

/** `rounded-[10px]`, `rounded-r-[10px]`, `rounded-tl-[6px]`, `md:rounded-[8px]` … */
const ARBITRARY_RADIUS = /(?<![\w-])(?:[\w-]+:)*rounded(?:-(?:t|r|b|l|s|e|tl|tr|bl|br|ss|se|es|ee))?-\[[^\]\s]+\]/g;

export function arbitraryRadiusTokens(line: string): string[] {
  return [...line.matchAll(ARBITRARY_RADIUS)].map(m => m[0]);
}

describe('arbitraryRadiusTokens', () => {
  it('finds bare and side-specific arbitrary radii, with variants', () => {
    expect(arbitraryRadiusTokens('className="rounded-[10px] px-4"')).toEqual(['rounded-[10px]']);
    expect(arbitraryRadiusTokens('border-l-2 rounded-r-[10px]')).toEqual(['rounded-r-[10px]']);
    expect(arbitraryRadiusTokens('md:rounded-tl-[6px]')).toEqual(['md:rounded-tl-[6px]']);
  });

  it('leaves the zeroed scale alone', () => {
    expect(arbitraryRadiusTokens('rounded rounded-full rounded-lg rounded-r-md')).toEqual([]);
  });
});

describe('square corners', () => {
  it('no source file uses an arbitrary border radius', () => {
    const hits: string[] = [];
    for (const f of new Glob('**/*.{ts,tsx}').scanSync(SRC)) {
      if (/\.test\.tsx?$/.test(f) || f.includes('/__tests__/')) continue;
      readFileSync(join(SRC, f), 'utf8').split('\n').forEach((line, i) => {
        for (const t of arbitraryRadiusTokens(line)) hits.push(`${f}:${i + 1} ${t}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

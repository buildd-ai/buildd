/**
 * Navigation R-15: one predicate decides "build complete" for every surface.
 * `isBuildComplete` (lib/build-complete.ts) is it. A second copy of
 * `total > 0 && done >= total` drifts from it (an empty mission, an off-by-one),
 * so any such comparison fails here: call isBuildComplete instead.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(import.meta.dir, '..');
const COUNT = String.raw`[\w.]*(?:total|Total|length)\w*`;
const DONE = String.raw`[\w.]*(?:done|Done|completed|Completed|landed|Landed)\w*`;
const PATTERNS = [
  new RegExp(String.raw`${COUNT}\s*>\s*0\s*&&\s*${DONE}\s*(?:>=|===)\s*${COUNT}`),
  new RegExp(String.raw`${DONE}\s*(?:>=|===)\s*${COUNT}\s*&&\s*${COUNT}\s*>\s*0`),
];
// Sites that legitimately compare a different pair of numbers.
const ALLOWED = new Set([
  'lib/build-complete.ts', // isBuildComplete itself
  'lib/initiative-view.ts', // counts an initiative's missions, not a mission's tasks
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('one build-complete predicate (Navigation R-15)', () => {
  test('no second `total > 0 && done >= total` outside isBuildComplete', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (ALLOWED.has(rel)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (PATTERNS.some(re => re.test(line))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('the guard recognises the shapes it forbids', () => {
    expect(PATTERNS.some(re => re.test('x.total > 0 && x.done >= x.total'))).toBe(true);
    expect(PATTERNS.some(re => re.test('completedTasks >= totalTasks && totalTasks > 0'))).toBe(true);
  });
});

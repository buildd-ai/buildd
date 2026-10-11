/**
 * The task page carries no all-caps, letter-spaced labels
 * (docs/design/design-system.md §1.1 "Labels"): chips, stat tiles, rail labels
 * and section headers are sentence case. Negative tracking on headings is fine;
 * positive tracking only exists to space out capitals.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dir;
const MASTHEAD = join(HERE, '../../../../../components/missions/MissionMasthead.tsx');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

const CAPS = /(?<![\w-])uppercase(?![\w-])/;
const TRACKED = /(?<![\w-])tracking-(?:wide|wider|widest|\[(?!-)[^\]]+\])/;

describe('task page labels are sentence case', () => {
  for (const file of [...sources(HERE), MASTHEAD]) {
    test(file.slice(file.indexOf('apps/web')), () => {
      const hits = readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line: i + 1, text: line.trim() }))
        .filter(l => CAPS.test(l.text) || TRACKED.test(l.text));
      expect(hits).toEqual([]);
    });
  }
});

describe('activity section has one header', () => {
  test('the milestone log toggle does not restate the section as "Log ·"', () => {
    const src = readFileSync(join(HERE, 'WorkerActivityTimeline.tsx'), 'utf8');
    expect(src).not.toContain('Log ·');
  });
});

/**
 * R-43 (workflow-kernel-library.md §4): a rail's refusal reason reaches people verbatim, as
 * "Merge blocked: <reason>" on the Buildd / Review approval status and in the page a person
 * gets. So no reason a rail can return may say "land" / "landing" / "landed": the plain term
 * is merge. Internal identifiers (`buildd/landing`, `landing_needs_human`, function names)
 * are not prose and stay.
 *
 * This reads the rail sources rather than driving every refusal, so a new reason added to any
 * of them is covered the day it is written. Comments and log lines (`[auto-merge] ...`) are
 * not people-facing and are skipped.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const RAIL_SOURCES = [
  'auto-merge.ts',
  'auto-merge-bound.ts',
  'auto-merge-grace.ts',
  'migration-safety.ts',
  'migration-inspector.ts',
  'base-refresh.ts',
];

/** Every prose string literal (it has a space in it) in a source file, with its line. */
function proseLiterals(src: string): { line: number; text: string }[] {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:'"`\\])\/\/.*$/gm, (m, pre: string) => pre + blank(m.slice(pre.length)));
  const re = /'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"/g;
  const out: { line: number; text: string }[] = [];
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (!/\s/.test(m[0])) continue;
    out.push({ line: code.slice(0, m.index).split('\n').length, text: m[0] });
  }
  return out;
}

describe('rail refusal reasons say merge, never land (R-43)', () => {
  for (const file of RAIL_SOURCES) {
    it(file, () => {
      const src = readFileSync(join(import.meta.dir, file), 'utf8');
      const hits = proseLiterals(src)
        .filter((l) => /\bland/i.test(l.text))
        .filter((l) => !/^.\[[\w-]+\]/.test(l.text)) // a console log line, not a reason
        .map((l) => `${file}:${l.line} ${l.text.slice(0, 100)}`);
      expect(hits).toEqual([]);
    });
  }

  it('the scan sees a reason that says land (it can fail)', () => {
    const hits = proseLiterals("return { ok: false, reason: 'Landing refused: x' };\n// landing is fine in a comment\n").filter((l) => /\bland/i.test(l.text));
    expect(hits.map((h) => h.line)).toEqual([1]);
  });
});

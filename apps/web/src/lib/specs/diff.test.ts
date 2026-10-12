import { describe, expect, test } from 'bun:test';
import { diffLines, diffSpecBodies, diffSpecHunks, MAX_DIFF_CHARS, MAX_DIFF_LINES } from './diff';

const SPEC = [
  '# Checkout',
  'Intro line.',
  '## Totals',
  'R-1: Totals are in the shopper currency.',
  '- AC-1 Given EUR, the total reads €.',
  '## Rates',
  'R-2: Rates come from the rates service.',
  '',
].join('\n');

describe('diffLines', () => {
  test('keeps common lines and marks only what changed', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'x' }, { op: ' ', text: 'c' },
    ]);
  });
  test('an insertion in the middle is one added line', () => {
    const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'b', 'n', 'c', 'd']);
    expect(ops.filter((o) => o.op !== ' ')).toEqual([{ op: '+', text: 'n' }]);
  });
});

describe('diffSpecBodies', () => {
  test('identical revisions say no change', () => {
    expect(diffSpecBodies(SPEC, SPEC)).toEqual({ identical: true, sections: [], diff: '', omittedLines: 0 });
  });

  test('a changed line is reported on its own section only, with the line diff', () => {
    const next = SPEC.replace('R-2: Rates come from the rates service.', 'R-2: Rates are cached for 15 minutes.');
    const d = diffSpecBodies(SPEC, next);
    expect(d.sections).toEqual([{ kind: 'changed', path: 'Checkout > Rates', level: 2, linesAdded: 1, linesRemoved: 1 }]);
    expect(d.diff).toBe([
      '@@ Checkout > Rates (changed) @@',
      ' ## Rates',
      '-R-2: Rates come from the rates service.',
      '+R-2: Rates are cached for 15 minutes.',
    ].join('\n'));
    expect(d.omittedLines).toBe(0);
  });

  test('added and removed sections, in document order', () => {
    const next = SPEC.replace('## Rates\nR-2: Rates come from the rates service.\n', '## Refunds\nR-3: Refunds go back to the card.\n');
    const d = diffSpecBodies(SPEC, next);
    expect(d.sections.map((s) => [s.kind, s.path])).toEqual([['removed', 'Checkout > Rates'], ['added', 'Checkout > Refunds']]);
    expect(d.diff).toContain('-R-2: Rates come from the rates service.');
    expect(d.diff).toContain('+R-3: Refunds go back to the card.');
  });

  test('text before the first heading is its own section', () => {
    const d = diffSpecBodies('Draft notes\n# A\nx\n', 'Final notes\n# A\nx\n');
    expect(d.sections.map((s) => s.path)).toEqual(['(before the first heading)']);
  });

  test('a long unchanged stretch inside a section is elided', () => {
    const body = (mid: string) => ['# A', ...Array.from({ length: 50 }, (_, i) => `line ${i}`), mid, ...Array.from({ length: 50 }, (_, i) => `tail ${i}`), ''].join('\n');
    const d = diffSpecBodies(body('old'), body('new'));
    expect(d.diff.split('\n')).toEqual(['@@ A (changed) @@', '...', ' line 48', ' line 49', '-old', '+new', ' tail 0', ' tail 1']);
  });

  test('a 200,000-character rewrite stays bounded and says how much it left out', () => {
    const big = (tag: string) => ['# Reference', ...Array.from({ length: 5_000 }, (_, i) => `${tag} paragraph ${i} ${'x'.repeat(30)}`), ''].join('\n');
    const from = big('old'); const to = big('new');
    expect(from.length).toBeGreaterThan(200_000);
    const d = diffSpecBodies(from, to);
    expect(d.diff.split('\n').length).toBeLessThanOrEqual(MAX_DIFF_LINES);
    expect(d.diff.length).toBeLessThanOrEqual(MAX_DIFF_CHARS);
    expect(d.omittedLines).toBeGreaterThan(9_000);
    expect(d.sections).toEqual([{ kind: 'changed', path: 'Reference', level: 1, linesAdded: 5_000, linesRemoved: 5_000 }]);
  });
});

describe('diffSpecHunks', () => {
  test('rows carry document line numbers on the side each line lives on', () => {
    const next = SPEC.replace('R-2: Rates come from the rates service.', 'R-2: Rates are cached for 15 minutes.');
    const h = diffSpecHunks(SPEC, next);
    expect(h.omittedLines).toBe(0);
    expect(h.hunks).toEqual([{
      kind: 'changed', path: 'Checkout > Rates', linesAdded: 1, linesRemoved: 1,
      rows: [
        { op: ' ', oldLine: 6, newLine: 6, text: '## Rates' },
        { op: '-', oldLine: 7, newLine: null, text: 'R-2: Rates come from the rates service.' },
        { op: '+', oldLine: null, newLine: 7, text: 'R-2: Rates are cached for 15 minutes.' },
      ],
    }]);
  });

  test('a first revision is every line added, numbered from line 1', () => {
    const h = diffSpecHunks('', SPEC);
    expect(h.hunks.map((x) => x.path)).toEqual(['Checkout', 'Checkout > Totals', 'Checkout > Rates']);
    expect(h.hunks[0].rows[0]).toEqual({ op: '+', oldLine: null, newLine: 1, text: '# Checkout' });
    expect(h.hunks[2].rows[0]).toEqual({ op: '+', oldLine: null, newLine: 6, text: '## Rates' });
  });

  test('a removed section keeps its old line numbers', () => {
    const next = SPEC.replace('## Rates\nR-2: Rates come from the rates service.\n', '');
    const h = diffSpecHunks(SPEC, next);
    expect(h.hunks[0].rows).toEqual([
      { op: '-', oldLine: 6, newLine: null, text: '## Rates' },
      { op: '-', oldLine: 7, newLine: null, text: 'R-2: Rates come from the rates service.' },
    ]);
  });

  test('elided context is a gap row, and the rows say the same as the text diff', () => {
    const long = ['# A', ...Array.from({ length: 12 }, (_, i) => `line ${i + 1}`), ''].join('\n');
    const next = long.replace('line 2\n', 'line two\n').replace('line 11\n', 'line eleven\n');
    const h = diffSpecHunks(long, next);
    const d = diffSpecBodies(long, next);
    const rows = h.hunks[0].rows;
    expect(rows.some((r) => r.op === 'gap')).toBe(true);
    const asText = [`@@ ${h.hunks[0].path} (${h.hunks[0].kind}) @@`, ...rows.map((r) => (r.op === 'gap' ? '...' : `${r.op}${r.text}`))].join('\n');
    expect(asText).toBe(d.diff);
    const after = rows[rows.findIndex((r) => r.op === 'gap') + 1];
    expect(after.oldLine).toBe(after.newLine);
  });

  test('bounded by the same caps as the text diff', () => {
    const big = ['# Big', ...Array.from({ length: MAX_DIFF_LINES * 2 }, (_, i) => `row ${i}`), ''].join('\n');
    const h = diffSpecHunks('', big);
    const d = diffSpecBodies('', big);
    const shown = h.hunks.reduce((n, x) => n + 1 + x.rows.length, 0);
    expect(shown).toBe(MAX_DIFF_LINES);
    expect(h.omittedLines).toBe(d.omittedLines);
  });

  test('identical revisions have no hunks', () => {
    expect(diffSpecHunks(SPEC, SPEC)).toEqual({ hunks: [], omittedLines: 0 });
  });
});

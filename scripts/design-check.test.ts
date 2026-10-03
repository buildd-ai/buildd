import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findRegressions,
  parseBaseline,
  readSources,
  scanSources,
  serializeBaseline,
  updatedBaseline,
} from './design-check';

const OLD = 'apps/web/src/app/old.tsx';
const NEW = 'apps/web/src/app/new.tsx';

describe('design-check', () => {
  it('reports a regression by the file that introduced it, not pre-existing debt', () => {
    const before = scanSources([
      { path: OLD, content: '<span className="text-[13px]" />\n<span className="text-[11px]" />' },
    ]);
    const after = scanSources([
      { path: OLD, content: '<span className="text-[13px]" />\n<span className="text-[11px]" />' },
      { path: NEW, content: 'const x = 1;\n<span className="text-[12px] px-2" />' },
    ]);

    const regressions = findRegressions(before.counts, after.counts, after.violations);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].rule).toBe('arbitraryFontSizes');
    expect(regressions[0].offenders.map(v => `${v.file}:${v.line}`)).toEqual([`${NEW}:2`]);
  });

  it('passes when a violation only moves within the same total', () => {
    const before = scanSources([{ path: OLD, content: 'function StatusBadge() {}' }]);
    const after = scanSources([{ path: NEW, content: 'function StatusBadge() {}' }]);
    expect(findRegressions(before.counts, after.counts, after.violations)).toEqual([]);
  });

  it('flags rounded-full only on chip-like elements', () => {
    const { counts } = scanSources([
      {
        path: OLD,
        content: [
          '<img className="w-8 h-8 rounded-full" />',
          '<span className="w-2 h-2 rounded-full bg-status-ok" />',
          '<span className="px-2 py-0.5 rounded-full text-xs">beta</span>',
          '<span className="rounded-full text-[10px] uppercase">new</span>',
        ].join('\n'),
      },
    ]);
    expect(counts.roundedFullChips[OLD]).toBe(2);
  });

  it('--update lowers counts but refuses to raise them without --allow-increase', () => {
    const baseline = scanSources([
      { path: OLD, content: '<span className="text-[13px]" />\n<span className="text-[11px]" />' },
    ]).counts;
    const paidDown = scanSources([{ path: OLD, content: '<span className="text-[13px]" />' }]).counts;
    const lowered = updatedBaseline(baseline, paidDown, false);
    expect(lowered.refused).toEqual([]);
    expect(lowered.next.arbitraryFontSizes).toEqual({ [OLD]: 1 });

    const grown = scanSources([
      { path: OLD, content: '<span className="text-[13px]" />\n<span className="text-[11px]" />' },
      { path: NEW, content: '<span className="text-[9px]" />' },
    ]).counts;
    expect(updatedBaseline(baseline, grown, false).refused).toEqual(['arbitraryFontSizes']);
    expect(updatedBaseline(baseline, grown, true).next.arbitraryFontSizes).toEqual({ [OLD]: 2, [NEW]: 1 });
  });

  it('rejects an unparseable or incomplete baseline instead of passing', () => {
    expect(() => parseBaseline('not json')).toThrow();
    expect(() => parseBaseline('{"arbitraryFontSizes":{}}')).toThrow(/missing rule/);
  });

  it('round-trips a baseline without volatile fields', () => {
    const { counts } = scanSources([{ path: OLD, content: '<div className="fixed inset-0" />' }]);
    const raw = serializeBaseline(counts);
    expect(raw).not.toContain('timestamp');
    expect(parseBaseline(raw)).toEqual(counts);
  });

  it('fails loudly on a missing scan root', () => {
    expect(() => readSources(join(mkdtempSync(join(tmpdir(), 'dc-')), 'absent'))).toThrow(/does not exist/);
  });

});

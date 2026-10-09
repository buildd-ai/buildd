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

  const flagged = (path: string, line: string, key: keyof ReturnType<typeof scanSources>['counts']) =>
    scanSources([{ path, content: line }]).counts[key][path] ?? 0;

  it('flags a hand-rolled framed box but not Card, a hairline row, or a pill', () => {
    expect(flagged(OLD, '<div className="rounded-lg border border-border p-4" />', 'framedBoxes')).toBe(1);
    expect(flagged(OLD, '<div className="border rounded-md px-3" />', 'framedBoxes')).toBe(1);
    expect(flagged(OLD, '<div className="card p-4" />', 'framedBoxes')).toBe(0);
    expect(flagged(OLD, '<div className="border-b border-border py-2" />', 'framedBoxes')).toBe(0);
    expect(flagged('apps/web/src/components/ui/Card.tsx', '<div className="rounded-lg border p-4" />', 'framedBoxes')).toBe(0);
  });

  it('flags uppercase and arbitrary tracking labels', () => {
    expect(flagged(OLD, '<span className="text-meta uppercase">Status</span>', 'trackedLabels')).toBe(1);
    expect(flagged(OLD, '<span className="tracking-[0.08em]">x</span>', 'trackedLabels')).toBe(1);
    expect(flagged(OLD, '<span className="normal-case tracking-tight">x</span>', 'trackedLabels')).toBe(0);
  });

  it('flags accent fills and accent selected states outside the allowed components', () => {
    expect(flagged(OLD, '<div className="bg-accent text-white" />', 'accentFills')).toBe(1);
    expect(flagged(OLD, '<button className="bg-primary/10" />', 'accentFills')).toBe(1);
    expect(flagged(OLD, "<b className={active ? 'border-accent' : ''} />", 'accentFills')).toBe(1);
    expect(flagged(OLD, '<span className="text-accent-text" />', 'accentFills')).toBe(0);
    expect(flagged('apps/web/src/components/ui/PrimaryAction.tsx', '<a className="bg-accent" />', 'accentFills')).toBe(0);
    expect(flagged('apps/web/src/app/home/NeedsYouCards.tsx', '<a className="bg-accent" />', 'accentFills')).toBe(0);
  });

  it('flags tinted state boxes', () => {
    expect(flagged(OLD, '<div className="bg-status-error/10" />', 'tintedStateBoxes')).toBe(1);
    expect(flagged(OLD, '<span className="bg-status-error" />', 'tintedStateBoxes')).toBe(0);
  });

  it('per-file rules fail on a new file even when another file paid down', () => {
    const line = '<div className="bg-status-error/10" />';
    const before = scanSources([{ path: OLD, content: `${line}\n${line}` }]);
    const after = scanSources([
      { path: OLD, content: line },
      { path: NEW, content: line },
    ]);
    const r = findRegressions(before.counts, after.counts, after.violations);
    expect(r.map(x => x.rule)).toEqual(['tintedStateBoxes']);
    expect(r[0].offenders.map(v => v.file)).toEqual([NEW]);
  });

  it('--update keeps entries for files that still have violations', () => {
    const baseline = scanSources([{ path: OLD, content: 'function StatusBadge() {}' }]).counts;
    const renamed = scanSources([{ path: NEW, content: 'function StatusBadge() {}' }]).counts;
    expect(updatedBaseline(baseline, renamed, false).next.localStatusBadges).toEqual({ [NEW]: 1 });
  });
});

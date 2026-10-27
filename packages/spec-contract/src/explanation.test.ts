import { describe, expect, it } from 'bun:test';
import { explanationCoverage, parseExplanation, sectionWordChanges, type SpecExplanation } from './explanation';
import type { ChangeLine, SectionTextChange } from './criterion-review';

const changed = (id: string): ChangeLine => ({ kind: 'changed', id, text: `${id} new`, oldText: `${id} old`, words: [{ op: '-', text: 'old' }, { op: '+', text: 'new' }], section: 'Spec > Requirements' });
const added = (id: string) => ({ kind: 'added' as const, id, text: `${id} text`, section: 'Spec > Requirements' });
const four: ChangeLine[] = [changed('R-1'), changed('R-2'), changed('R-3'), changed('AC-1')];
const expl = (lines: Record<string, string>, summary = 'Totals round to cents.'): SpecExplanation => ({ summary, lines });

describe('parseExplanation (R-15)', () => {
  it('accepts a summary and lines keyed by criterion id or section heading', () => {
    const r = parseExplanation({ summary: ' Rounds totals. ', lines: { 'R-1': 'Now rounds.', 'Out of scope': 'Drops refunds.' } });
    expect(r).toEqual({ ok: true, explanation: { summary: 'Rounds totals.', lines: { 'R-1': 'Now rounds.', 'Out of scope': 'Drops refunds.' } } });
  });

  it('omitted or null is no explanation', () => {
    expect(parseExplanation(undefined)).toEqual({ ok: true, explanation: null });
    expect(parseExplanation(null)).toEqual({ ok: true, explanation: null });
  });

  it('refuses a summary over one line, a missing summary, and lines that are not text', () => {
    expect(parseExplanation({ summary: 'a\nb', lines: {} }).ok).toBe(false);
    expect(parseExplanation({ lines: { 'R-1': 'x' } }).ok).toBe(false);
    expect(parseExplanation({ summary: 'ok', lines: { 'R-1': 3 } }).ok).toBe(false);
    expect(parseExplanation({ summary: 'ok', lines: { 'R-1': '  ' } }).ok).toBe(false);
    expect(parseExplanation('just text').ok).toBe(false);
  });

  it('normalises criterion ids so r-1 and R-1 are one key', () => {
    const r = parseExplanation({ summary: 's', lines: { 'r-1': 'a' } });
    expect(r.ok && r.explanation?.lines).toEqual({ 'R-1': 'a' });
  });
});

describe('explanationCoverage (R-16)', () => {
  it('AC-13: four changed criteria, a line for each, covers 4 of 4', () => {
    const c = explanationCoverage(expl({ 'R-1': 'a', 'R-2': 'b', 'R-3': 'c', 'AC-1': 'd' }), four, []);
    expect(c.passed).toBe(true);
    expect(c.line).toBe('Explanation covers 4 of 4 changes');
    expect(c.notExplained).toEqual([]);
    expect(c.items.map((i) => [i.key, i.explanation])).toEqual([['R-1', 'a'], ['R-2', 'b'], ['R-3', 'c'], ['AC-1', 'd']]);
  });

  it('AC-14: a missing criterion is listed under Not explained', () => {
    const c = explanationCoverage(expl({ 'R-1': 'a', 'R-2': 'b', 'AC-1': 'd' }), four, []);
    expect(c.passed).toBe(false);
    expect(c.notExplained.map((i) => i.key)).toEqual(['R-3']);
    expect(c.line).toBe('Covers 3 of 4: 1 not explained');
  });

  it('AC-15: a line naming a criterion that did not change, or does not exist, explains something that did not change', () => {
    const c = explanationCoverage(expl({ 'R-1': 'a', 'R-2': 'b', 'R-3': 'c', 'AC-1': 'd', 'R-9': 'ghost', 'Nowhere': 'no such heading' }), four, []);
    expect(c.passed).toBe(true);
    expect(c.extra).toEqual([{ key: 'R-9', text: 'ghost' }, { key: 'Nowhere', text: 'no such heading' }]);
  });

  it('AC-16: no explanation leaves every change not explained', () => {
    const c = explanationCoverage(null, four, [{ kind: 'changed', section: 'Spec > Context' }]);
    expect(c.passed).toBe(false);
    expect(c.notExplained.map((i) => i.key)).toEqual(['R-1', 'R-2', 'R-3', 'AC-1', 'Spec > Context']);
    expect(c.line).toBe('No explanation: 0 of 5 changes explained');
  });

  it('sections match by their full path or their own heading, # marks and › separators ignored', () => {
    const other: SectionTextChange[] = [{ kind: 'changed', section: 'Spec > Context' }, { kind: 'added', section: 'Spec > Out of scope' }, { kind: 'removed', section: 'Spec > Notes > Old' }];
    const c = explanationCoverage(expl({ '## Context': 'a', 'Spec › Out of scope': 'b', 'old': 'c' }), [], other);
    expect(c.passed).toBe(true);
    expect(c.line).toBe('Explanation covers 3 of 3 changes');
    expect(c.items.map((i) => [i.kind, i.change, i.key])).toEqual([['section', 'changed', 'Spec > Context'], ['section', 'added', 'Spec > Out of scope'], ['section', 'removed', 'Spec > Notes > Old']]);
  });

  it('a run of added criteria counts each id; a replacing criterion is covered by its id or an id it replaces', () => {
    const lines: ChangeLine[] = [
      { kind: 'added-range', label: 'R-4 – R-5', items: [added('R-4'), added('R-5')] },
      { kind: 'replacing', id: 'R-6', text: 't', section: 's', replaces: [{ id: 'R-2', oldText: 'o' }] },
      { kind: 'removed', id: 'R-3', oldText: 'gone', section: 's' },
    ];
    const c = explanationCoverage(expl({ 'R-4': 'a', 'R-5': 'b', 'R-2': 'merged into R-6', 'R-3': 'dropped' }), lines, []);
    expect(c.items.map((i) => [i.key, i.change])).toEqual([['R-4', 'added'], ['R-5', 'added'], ['R-6', 'replacing'], ['R-3', 'removed']]);
    expect(c.passed).toBe(true);
    expect(c.extra).toEqual([]);
  });

  it('a moved criterion need not be explained, and a line for it is not "did not change"', () => {
    const lines: ChangeLine[] = [{ kind: 'moved', id: 'R-7', text: 't', section: 'b', movedFrom: 'a' }, changed('R-1')];
    const c = explanationCoverage(expl({ 'R-1': 'a', 'R-7': 'moved up' }), lines, []);
    expect(c.total).toBe(1);
    expect(c.passed).toBe(true);
    expect(c.extra).toEqual([]);
  });

  it('one change reads in the singular; nothing changed passes', () => {
    expect(explanationCoverage(expl({ 'R-1': 'a' }), [changed('R-1')], []).line).toBe('Explanation covers 1 of 1 change');
    const none = explanationCoverage(null, [], []);
    expect(none.passed).toBe(true);
    expect(none.line).toBe('No criterion or section changed');
  });
});

describe('sectionWordChanges (R-17)', () => {
  it('gives the changed words of each changed section outside the criteria', () => {
    const from = '# Spec\n\n## Context\n\nThe old words.\n\n## Requirements\n\n- R-1: one\n';
    const to = '# Spec\n\n## Context\n\nThe new words.\n\n## Requirements\n\n- R-1: one\n';
    const w = sectionWordChanges(from, to, [{ kind: 'changed', section: 'Spec > Context' }]);
    expect(w['Spec > Context']!.filter((o) => o.op !== '=').map((o) => `${o.op}${o.text}`)).toEqual(['-old', '+new']);
  });
});

import { describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { evaluateGate, isJudgeable, LARGE_REVISION_LINES, wordSimilarity, type GateInput } from './approval-gate';

const h = (t: string) => createHash('sha256').update(t).digest('hex');
const rec = (id: string, text: string, o: { section?: string; checks?: string[]; screens?: string[]; replaces?: string[] } = {}) => ({
  id, text, textHash: h(text), section: o.section ?? 'Requirements', checks: o.checks ?? [], screens: o.screens ?? [], replaces: o.replaces ?? [],
});
const GWT = 'GIVEN a signed-in shopper WHEN they open the cart THEN the total shows in their own currency';
const base = (over: Partial<GateInput> = {}): GateInput => ({
  head: [rec('R-1', 'Totals are in the shopper currency.')], baseline: [rec('R-1', 'Totals are in the shopper currency.')],
  duplicateIds: [], reusedIds: [], summary: 'Tightened R-1.', changedLines: 4, missingPins: [], ...over,
});
const codes = (g: { refusals: Array<{ code: string }> }) => g.refusals.map((r) => r.code);

describe('evaluateGate refusals', () => {
  it('passes a clean revision', () => {
    const g = evaluateGate(base());
    expect([g.passed, g.refusals, g.warnings]).toEqual([true, [], []]);
  });
  it('allows a rewording of an existing id', () => {
    const g = evaluateGate(base({ head: [rec('R-1', 'Totals show in the shopper currency.')] }));
    expect(g.passed).toBe(true);
  });
  it('refuses an id whose words now mean something else (the Navigation r2 case)', () => {
    const g = evaluateGate(base({ head: [rec('R-1', 'The sidebar collapses below tablet width.')] }));
    expect(codes(g)).toEqual(['id_meaning_changed']);
    expect(g.refusals[0]!.ids).toEqual(['R-1']);
    expect(g.passed).toBe(false);
  });
  it('refuses a reworded id that also moved to another section when little is shared', () => {
    const baseline = [rec('R-1', 'Totals are in the shopper currency and rounded to cents.', { section: 'Cart' })];
    const head = [rec('R-1', 'Totals are rounded to cents on every page.', { section: 'Navigation' })];
    expect(codes(evaluateGate(base({ baseline, head })))).toEqual(['id_meaning_changed']);
  });
  it('does not check meaning when nothing is approved yet', () => {
    expect(evaluateGate(base({ baseline: null, head: [rec('R-1', 'anything at all')] })).passed).toBe(true);
  });
  it('refuses a duplicated id', () => {
    expect(codes(evaluateGate(base({ duplicateIds: ['R-2'] })))).toEqual(['duplicate_id']);
  });
  it('refuses a retired id that is back with other words, naming the revision', () => {
    const g = evaluateGate(base({ reusedIds: [{ id: 'R-4', retiredIn: 3 }] }));
    expect(codes(g)).toEqual(['retired_id_reused']);
    expect(g.refusals[0]!.message).toContain('R-4 was retired in revision 3');
  });
  it('refuses an acceptance check with no check line and nothing a reviewer can judge', () => {
    const g = evaluateGate(base({ head: [rec('R-1', 'Totals are in the shopper currency.'), rec('AC-1', 'The cart works well.')] }));
    expect(codes(g)).toEqual(['acceptance_unjudgeable']);
    expect(g.refusals[0]!.ids).toEqual(['AC-1']);
  });
  it('accepts an acceptance check by check line, by screen, or by GIVEN/WHEN/THEN with an observable result', () => {
    const head = [rec('R-1', 'Totals are in the shopper currency.'), rec('AC-1', 'x', { checks: ['bun test'] }), rec('AC-2', 'y', { screens: ['cart'] }), rec('AC-3', GWT)];
    expect(evaluateGate(base({ head })).passed).toBe(true);
  });
  it('refuses a GIVEN/WHEN/THEN with no result after THEN', () => {
    expect(isJudgeable({ text: 'GIVEN a shopper WHEN they pay THEN ok', checks: [], screens: [] })).toBe(false);
  });
  it('leaves an unchanged acceptance criterion alone', () => {
    const old = rec('AC-1', 'The cart works well.');
    expect(evaluateGate(base({ baseline: [old], head: [old] })).passed).toBe(true);
  });
  it('refuses a design or attachment pinned to a version that no longer exists', () => {
    const g = evaluateGate(base({ missingPins: ['The design is pinned to revision 2 of its artifact, which no longer exists'] }));
    expect(codes(g)).toEqual(['pin_missing']);
  });
});

describe('evaluateGate warnings', () => {
  it('warns, without refusing, when there is no change summary', () => {
    const g = evaluateGate(base({ summary: '  ' }));
    expect([g.passed, g.warnings.map((w) => w.code)]).toEqual([true, ['no_change_summary']]);
  });
  it('does not ask for a summary on a first revision', () => {
    expect(evaluateGate(base({ baseline: null, summary: null })).warnings).toEqual([]);
  });
  it('warns on a revision larger than the set size', () => {
    const g = evaluateGate(base({ changedLines: LARGE_REVISION_LINES + 1 }));
    expect([g.passed, g.warnings.map((w) => w.code)]).toEqual([true, ['large_revision']]);
  });
  it('warns when criteria are removed with no replacement noted', () => {
    const baseline = [rec('R-1', 'Totals are in the shopper currency.'), rec('R-2', 'Tax is itemised.'), rec('R-3', 'Shipping is itemised.')];
    const head = [rec('R-1', 'Totals are in the shopper currency.')];
    const g = evaluateGate(base({ baseline, head, summary: 'Dropped R-3, folded into totals.' }));
    expect(g.passed).toBe(true);
    expect(g.warnings.map((w) => [w.code, w.ids])).toEqual([['removed_without_replacement', ['R-2']]]);
  });
  it('is quiet about a removal a replaces line names', () => {
    const baseline = [rec('R-1', 'Totals are in the shopper currency.'), rec('R-2', 'Tax is itemised.')];
    const head = [rec('R-1', 'Totals are in the shopper currency.'), rec('R-3', 'Tax and shipping are itemised.', { replaces: ['R-2'] })];
    expect(evaluateGate(base({ baseline, head })).warnings).toEqual([]);
  });
});

describe('wordSimilarity', () => {
  it('is 1 for the same words and near 0 for unrelated ones', () => {
    expect(wordSimilarity('A b c', 'a B c')).toBe(1);
    expect(wordSimilarity('totals in currency', 'sidebar collapses')).toBe(0);
  });
});

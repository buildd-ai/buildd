import { describe, expect, test } from 'bun:test';
import { answerRetirementBatch, decideImportCheck, importMismatchQuestion, parseRetirementProposal, type ImportCheckResult } from './import-check';

const checks = [{ criterionId: 'R-1', command: 'bun test a' }, { criterionId: 'AC-2', command: 'bun test b' }];
const pass = (id: string): ImportCheckResult => ({ criterionId: id, outcome: 'pass' });

describe('decideImportCheck (R-370, AC-370)', () => {
  test('confirms only when every check passed', () => {
    expect(decideImportCheck(checks, [pass('R-1'), pass('AC-2')])).toEqual({ kind: 'confirm' });
  });
  test('a spec with no check line is never confirmed and raises nothing', () => {
    expect(decideImportCheck([], [])).toEqual({ kind: 'none', reason: 'no_checks' });
  });
  test('a check not run yet waits, with no question', () => {
    expect(decideImportCheck(checks, [pass('R-1')])).toEqual({ kind: 'none', reason: 'not_run' });
  });
  test('a failing or erroring check is a mismatch', () => {
    const d = decideImportCheck(checks, [pass('R-1'), { criterionId: 'AC-2', outcome: 'fail' }]);
    expect(d).toEqual({ kind: 'mismatch', failed: [{ criterionId: 'AC-2', outcome: 'fail' }] });
    expect(decideImportCheck(checks, [pass('R-1'), { criterionId: 'AC-2', outcome: 'error' }]).kind).toBe('mismatch');
  });
  test('a failure outranks a missing result', () => {
    expect(decideImportCheck(checks, [{ criterionId: 'R-1', outcome: 'fail' }]).kind).toBe('mismatch');
  });
});

describe('importMismatchQuestion (R-371, AC-371)', () => {
  test('three failing checks are one question naming the spec and a recommendation', () => {
    const q = importMismatchQuestion('Widget rules', [
      { criterionId: 'R-1', outcome: 'fail' }, { criterionId: 'R-2', outcome: 'fail' }, { criterionId: 'AC-3', outcome: 'error' },
    ]);
    expect(q.text).toContain('Widget rules');
    expect(q.text).toContain('R-1');
    expect(q.text).toContain('AC-3');
    expect(q.text).not.toMatch(/[.!?]\s+\S/);
    expect(q.recommended.length).toBeGreaterThan(0);
  });
});

describe('retirement batch (R-372, AC-372)', () => {
  const live = ['a', 'b', 'c', 'd'].map((x) => ({ specId: `spec-${x}`, title: `Spec ${x}` }));
  const items = live.map((l) => ({ specId: l.specId, reason: `The ${l.title} is stale and covered elsewhere` }));

  test('parses one proposal listing each spec with a reason', () => {
    const p = parseRetirementProposal(items, live);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.items.map((i) => i.title)).toEqual(['Spec a', 'Spec b', 'Spec c', 'Spec d']);
  });
  test('refuses a short reason, a duplicate, an unknown spec and an empty list', () => {
    expect(parseRetirementProposal([{ specId: 'spec-a', reason: 'old' }], live).ok).toBe(false);
    expect(parseRetirementProposal([items[0]!, items[0]!], live).ok).toBe(false);
    expect(parseRetirementProposal([{ specId: 'nope', reason: 'long enough reason' }], live).ok).toBe(false);
    expect(parseRetirementProposal([], live).ok).toBe(false);
  });
  test('one yes retires every listed spec; removing one retires only the rest', () => {
    const p = parseRetirementProposal(items, live);
    if (!p.ok) throw new Error('parse');
    expect(answerRetirementBatch(p.items, undefined).map((i) => i.specId)).toEqual(live.map((l) => l.specId));
    expect(answerRetirementBatch(p.items, ['spec-a', 'spec-b', 'spec-d']).map((i) => i.specId)).toEqual(['spec-a', 'spec-b', 'spec-d']);
  });
  test('an answer can never add a spec the owner did not see listed', () => {
    const p = parseRetirementProposal(items, live);
    if (!p.ok) throw new Error('parse');
    expect(answerRetirementBatch(p.items, ['spec-a', 'spec-zzz']).map((i) => i.specId)).toEqual(['spec-a']);
  });
});

/**
 * The governed-outcome fold (Living Specs V1, D-5): verified only when every
 * criterion's newest verdict is a pass on the current head; fail when any
 * newest verdict is fail; unverified for everything else, never a pass by
 * default.
 */
import { describe, expect, it } from 'bun:test';
import { foldGovernedOutcome, boundEvidenceRefs, verdictSourceOf, verdictSourceOfEvidence, type CriterionVerdict } from '../verification-check';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const v = (criterionId: string, verdict: CriterionVerdict['verdict'], headSha: string | null, at: number): CriterionVerdict =>
  ({ criterionId, verdict, headSha, at: new Date(at) });

describe('foldGovernedOutcome', () => {
  it('verified: every criterion passes on the current head', () => {
    const r = foldGovernedOutcome(['R-1', 'AC-1'], [v('R-1', 'pass', HEAD, 1), v('AC-1', 'pass', HEAD, 2)], HEAD);
    expect(r.outcome).toBe('verified');
    expect(r.criteria.every((c) => c.holds)).toBe(true);
  });

  it('fail: a newest fail on any criterion, at any head, and it outranks a missing verdict', () => {
    expect(foldGovernedOutcome(['R-1', 'R-2'], [v('R-1', 'fail', HEAD, 1)], HEAD)).toMatchObject({ outcome: 'fail', reason: 'R-1 failed' });
    expect(foldGovernedOutcome(['R-1'], [v('R-1', 'fail', OLD, 1)], HEAD).outcome).toBe('fail');
  });

  it('the newest verdict per criterion stands: a later pass clears an earlier fail, a later fail undoes a pass', () => {
    expect(foldGovernedOutcome(['R-1'], [v('R-1', 'fail', OLD, 1), v('R-1', 'pass', HEAD, 2)], HEAD).outcome).toBe('verified');
    expect(foldGovernedOutcome(['R-1'], [v('R-1', 'pass', HEAD, 2), v('R-1', 'fail', HEAD, 3)], HEAD).outcome).toBe('fail');
    // Order of the input does not matter, only the times.
    expect(foldGovernedOutcome(['R-1'], [v('R-1', 'pass', HEAD, 5), v('R-1', 'fail', OLD, 1)], HEAD).outcome).toBe('verified');
  });

  it('unverified, never pass: a missing verdict, inconclusive, unsupported, a pass on an older head, no head, no criteria', () => {
    const cases: Array<[string[], CriterionVerdict[], string | null]> = [
      [['R-1', 'R-2'], [v('R-1', 'pass', HEAD, 1)], HEAD],
      [['R-1'], [v('R-1', 'inconclusive', HEAD, 1)], HEAD],
      [['R-1'], [v('R-1', 'unsupported', HEAD, 1)], HEAD],
      [['R-1'], [v('R-1', 'pass', OLD, 1)], HEAD],
      [['R-1'], [v('R-1', 'pass', HEAD, 1)], null],
      [[], [], HEAD],
    ];
    for (const [criteria, verdicts, head] of cases) expect(foldGovernedOutcome(criteria, verdicts, head).outcome).toBe('unverified');
    expect(foldGovernedOutcome(['R-1'], [v('R-1', 'pass', OLD, 1)], HEAD).criteria[0]).toMatchObject({ stale: true, holds: false });
  });

  it('a short SHA binds to the full head it prefixes; a verdict on an unknown criterion is ignored', () => {
    expect(foldGovernedOutcome(['R-1'], [v('R-1', 'pass', HEAD.slice(0, 7), 1)], HEAD).outcome).toBe('verified');
    expect(foldGovernedOutcome(['R-1'], [v('R-1', 'pass', HEAD, 1), v('R-9', 'fail', HEAD, 2)], HEAD).outcome).toBe('verified');
  });
});

describe('boundEvidenceRefs', () => {
  it('keeps well-formed refs only, capped', () => {
    expect(boundEvidenceRefs([{ kind: 'file', ref: 'a.ts:1' }, { kind: 1 }, 'x', null])).toEqual([{ kind: 'file', ref: 'a.ts:1' }]);
    expect(boundEvidenceRefs(Array.from({ length: 20 }, (_, i) => ({ kind: 'k', ref: String(i) }))).length).toBe(10);
    expect(boundEvidenceRefs('nope')).toEqual([]);
  });
});

describe('verdict source precedence (a test result outranks a reviewer opinion)', () => {
  const t = (criterionId: string, verdict: CriterionVerdict['verdict'], headSha: string | null, at: number): CriterionVerdict =>
    ({ criterionId, verdict, headSha, at: new Date(at), source: 'test' });
  const r = (criterionId: string, verdict: CriterionVerdict['verdict'], headSha: string | null, at: number): CriterionVerdict =>
    ({ criterionId, verdict, headSha, at: new Date(at), source: 'review' });

  it('a later review pass cannot override a failed test', () => {
    const out = foldGovernedOutcome(['R-1'], [t('R-1', 'fail', HEAD, 1), r('R-1', 'pass', HEAD, 2)], HEAD);
    expect(out.outcome).toBe('fail');
    expect(out.criteria[0]).toMatchObject({ verdict: 'fail', source: 'test' });
  });

  it('a later review fail does not undo a passing test on the current head', () => {
    const out = foldGovernedOutcome(['R-1'], [t('R-1', 'pass', HEAD, 1), r('R-1', 'fail', HEAD, 2)], HEAD);
    expect(out.outcome).toBe('verified');
    expect(out.criteria[0].source).toBe('test');
  });

  it('a later test supersedes an earlier test, and a review cannot rescue a stale test pass', () => {
    expect(foldGovernedOutcome(['R-1'], [t('R-1', 'fail', OLD, 1), t('R-1', 'pass', HEAD, 2)], HEAD).outcome).toBe('verified');
    expect(foldGovernedOutcome(['R-1'], [t('R-1', 'pass', OLD, 1), r('R-1', 'pass', HEAD, 2)], HEAD).outcome).toBe('unverified');
  });

  it('a test that settled nothing (inconclusive, unsupported) does not suppress a review', () => {
    expect(foldGovernedOutcome(['R-1'], [t('R-1', 'unsupported', HEAD, 1), r('R-1', 'pass', HEAD, 2)], HEAD).outcome).toBe('verified');
  });

  it('with no test result the newest review stands, and an unlabelled verdict reads as a review', () => {
    expect(foldGovernedOutcome(['R-1'], [r('R-1', 'fail', HEAD, 1), r('R-1', 'pass', HEAD, 2)], HEAD).criteria[0].source).toBe('review');
    expect(foldGovernedOutcome(['R-1'], [v('R-1', 'pass', HEAD, 1)], HEAD).criteria[0].source).toBe('review');
    expect(foldGovernedOutcome(['R-1'], [], HEAD).criteria[0].source).toBeNull();
  });
});

describe('verdictSourceOf', () => {
  it('check runs are tests; people, final verification and visual audits are reviews', () => {
    expect(verdictSourceOf('check:abc')).toBe('test');
    for (const by of ['user:u1', 'account:a1', 'final-verification:t1', 'visual:t2', undefined, null, 5]) expect(verdictSourceOf(by)).toBe('review');
    expect(verdictSourceOfEvidence({ recordedBy: 'check:x' })).toBe('test');
    expect(verdictSourceOfEvidence(null)).toBe('review');
  });
});

describe('overriddenReviews on a standing (R-85)', () => {
  it('counts the reviews a deciding test outranks, and is 0 when a review decides', () => {
    const t = foldGovernedOutcome(['R-1'], [{ ...v('R-1', 'pass', HEAD, 1), source: 'test' as const }, v('R-1', 'fail', HEAD, 2), v('R-1', 'fail', HEAD, 3)], HEAD);
    expect(t.criteria[0].overriddenReviews).toBe(2);
    const r = foldGovernedOutcome(['R-1'], [v('R-1', 'pass', HEAD, 1)], HEAD);
    expect(r.criteria[0].overriddenReviews).toBe(0);
  });
});

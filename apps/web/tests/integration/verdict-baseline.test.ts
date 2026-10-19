/**
 * Baseline validation for criterion verdicts, run in isolation: pure folds over
 * verdict rows, no server, no database.
 *
 * A baseline verdict records the state a criterion already held before the work
 * (author `baseline:<id>`, verified_by `baseline`). It ranks as a review, is
 * bound to the base head it was taken on, and so can neither mask a regression
 * nor stand in for a check on the branch.
 */
import { describe, expect, it } from 'bun:test';
import {
  determiningVerdict, foldGovernedOutcome, verdictSourceOf, verifiedByOf, verifiedByOfEvidence,
} from '../../../../packages/spec-contract/src/outcome';
import { HEAD, OLD, review, test_ } from './fixtures/verdict-cases';

/** A baseline verdict: taken on the base head (OLD), ranked as a review. */
const baseline = (c: string, v: Parameters<typeof review>[1], at: number, h: string | null = OLD) => review(c, v, at, h);

describe('baseline verdict attribution', () => {
  it('a baseline author is verified_by baseline but still ranks as a review', () => {
    expect(verifiedByOf('baseline:t1')).toBe('baseline');
    expect(verdictSourceOf('baseline:t1')).toBe('review');
    expect(verifiedByOfEvidence({ recordedBy: 'baseline:t1' })).toBe('baseline');
    expect(verifiedByOf('check:t1')).toBe('test');
    expect(verifiedByOf('user:u')).toBe('review');
    expect(verifiedByOf(undefined)).toBe('review');
  });
});

describe('baseline-red', () => {
  it('a criterion red at baseline is not verified, and fails the outcome', () => {
    const out = foldGovernedOutcome(['R-1'], [baseline('R-1', 'fail', 1)], HEAD);
    expect(out.outcome).toBe('fail');
    expect(out.reason).toContain('R-1');
  });

  it('a branch test pass decides over the red baseline', () => {
    const out = foldGovernedOutcome(['R-1'], [baseline('R-1', 'fail', 1), test_('R-1', 'pass', 2)], HEAD);
    expect(out.outcome).toBe('verified');
    expect(out.criteria[0]).toMatchObject({ verdict: 'pass', source: 'test', holds: true });
  });

  it('a red baseline recorded after the branch test cannot undo its pass', () => {
    const d = determiningVerdict([test_('R-1', 'pass', 1), { ...baseline('R-1', 'fail', 2), source: 'review' as const }]);
    expect(d).toMatchObject({ source: 'test', verdict: 'pass' });
  });

  it('red baseline on one criterion does not affect another', () => {
    const out = foldGovernedOutcome(['R-1', 'R-2'], [baseline('R-1', 'fail', 1), test_('R-2', 'pass', 2)], HEAD);
    const by = Object.fromEntries(out.criteria.map((c) => [c.criterionId, c]));
    expect(by['R-1'].verdict).toBe('fail');
    expect(by['R-2'].holds).toBe(true);
    expect(out.outcome).toBe('fail');
  });
});

describe('already-satisfied criteria', () => {
  it('a baseline pass is not a regression and is not verified on a new head', () => {
    const out = foldGovernedOutcome(['R-1'], [baseline('R-1', 'pass', 1)], HEAD);
    expect(out.outcome).toBe('unverified');
    expect(out.criteria[0]).toMatchObject({ verdict: 'pass', stale: true, holds: false });
  });

  it('a baseline pass counts when the branch head is the base head', () => {
    const out = foldGovernedOutcome(['R-1'], [baseline('R-1', 'pass', 1, HEAD)], HEAD);
    expect(out.outcome).toBe('verified');
  });

  it('a branch test pass confirms an already-satisfied criterion', () => {
    const out = foldGovernedOutcome(['R-1'], [baseline('R-1', 'pass', 1), test_('R-1', 'pass', 2)], HEAD);
    expect(out.outcome).toBe('verified');
    expect(out.criteria[0]).toMatchObject({ source: 'test', stale: false });
  });
});

describe('regression: passes at baseline, fails on the branch', () => {
  it('a branch test fail decides over the baseline pass', () => {
    const out = foldGovernedOutcome(['R-1'], [baseline('R-1', 'pass', 1), test_('R-1', 'fail', 2)], HEAD);
    expect(out.outcome).toBe('fail');
    expect(out.criteria[0]).toMatchObject({ verdict: 'fail', source: 'test', holds: false });
    expect(out.reason).toContain('R-1');
  });

  it('a branch test fail is not rescued by a baseline pass recorded later', () => {
    const out = foldGovernedOutcome(['R-1'], [test_('R-1', 'fail', 1), baseline('R-1', 'pass', 2, HEAD)], HEAD);
    expect(out.outcome).toBe('fail');
    expect(out.criteria[0].source).toBe('test');
  });

  it('a newer branch review fail supersedes the baseline pass', () => {
    const out = foldGovernedOutcome(['R-1'], [baseline('R-1', 'pass', 1), review('R-1', 'fail', 2)], HEAD);
    expect(out.outcome).toBe('fail');
  });

  it('only the regressed criterion is named', () => {
    const out = foldGovernedOutcome(
      ['R-1', 'R-2'],
      [baseline('R-1', 'pass', 1), baseline('R-2', 'pass', 1), test_('R-1', 'pass', 2), test_('R-2', 'fail', 3)],
      HEAD,
    );
    expect(out.outcome).toBe('fail');
    expect(out.reason).toContain('R-2');
    expect(out.reason).not.toContain('R-1');
  });

  it('a later fix restores the criterion', () => {
    const out = foldGovernedOutcome(['R-1'], [baseline('R-1', 'pass', 1), test_('R-1', 'fail', 2), test_('R-1', 'pass', 3)], HEAD);
    expect(out.outcome).toBe('verified');
  });
});
